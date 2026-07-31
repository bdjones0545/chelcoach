/**
 * Bounded reconciliation batch for durable analysis jobs (Step 6).
 * Prefer invoking from an external scheduler / protected internal route.
 * Do not create one timer per job.
 */
import { getAnalysisJobRepository } from "./jobRepository";
import { synchronizeJob } from "./syncService";
import type { AnalysisJob } from "./types";

export interface AnalysisReconciliationBatchResult {
  examined: number;
  advanced: number;
  degraded: number;
  unchanged: number;
  failed: number;
  applicationRequestIds: string[];
}

function logEvent(event: string, fields: Record<string, string | number | boolean | undefined>): void {
  const parts = Object.entries(fields)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${v}`);
  console.log(`[chelcoach-reconciliation] event=${event} ${parts.join(" ")}`);
}

/** In-flight per-job locks — process-local; DB row locks cover multi-instance. */
const inflight = new Set<string>();

export class AnalysisReconciliationService {
  async runBatch(input?: {
    now?: Date;
    limit?: number;
  }): Promise<AnalysisReconciliationBatchResult> {
    const now = input?.now ?? new Date();
    const limit = Math.min(Math.max(input?.limit ?? 25, 1), 100);
    logEvent("reconciliation_batch_started", { limit });

    const candidates = await getAnalysisJobRepository().listReconciliationCandidates({
      now,
      limit,
    });

    const result: AnalysisReconciliationBatchResult = {
      examined: candidates.length,
      advanced: 0,
      degraded: 0,
      unchanged: 0,
      failed: 0,
      applicationRequestIds: candidates.map((c) => c.applicationRequestId),
    };

    for (const job of candidates) {
      if (inflight.has(job.applicationRequestId)) continue;
      inflight.add(job.applicationRequestId);
      try {
        const before = job.canonicalStatus;
        const sync = await synchronizeJob({
          applicationRequestId: job.applicationRequestId,
          trigger: "reconciliation",
          force: true,
        });
        if (sync.degraded) result.degraded += 1;
        else if (sync.job.canonicalStatus !== before || sync.job.reportAvailable !== job.reportAvailable) {
          result.advanced += 1;
        } else if (sync.synchronized) result.unchanged += 1;
        else result.unchanged += 1;
      } catch {
        result.failed += 1;
      } finally {
        inflight.delete(job.applicationRequestId);
      }
    }

    logEvent("reconciliation_batch_completed", {
      examined: result.examined,
      advanced: result.advanced,
      degraded: result.degraded,
      failed: result.failed,
    });
    return result;
  }
}

let service = new AnalysisReconciliationService();

export function getAnalysisReconciliationService(): AnalysisReconciliationService {
  return service;
}

export function setAnalysisReconciliationServiceForTests(
  next: AnalysisReconciliationService,
): void {
  service = next;
}

/** Startup helper — count candidates without blocking boot. */
export async function detectRestartRecoveryCandidates(limit = 5): Promise<AnalysisJob[]> {
  try {
    const rows = await getAnalysisJobRepository().listReconciliationCandidates({
      now: new Date(),
      limit,
    });
    if (rows.length) {
      logEvent("restart_recovery_candidate_detected", { count: rows.length });
    }
    return rows;
  } catch {
    return [];
  }
}
