/**
 * Provider-independent analysis job synchronization (Step 6).
 */
import { randomUUID } from "node:crypto";
import {
  analysisStatusLabel,
  applicationAnalysisStatusSchema,
  scottyJobStatusResponseSchema,
  scottyReportSchema,
  type ApplicationAnalysisStatus,
  type ScottyReport,
} from "../../scottyContract";
import { ProviderError } from "../errors";
import { createScottyProviderForMode, getScottyProvider } from "../factory";
import { loadScottyProviderConfig } from "../config";
import { checksumReport } from "./drizzleJobRepository";
import { getAnalysisJobRepository, OptimisticConcurrencyError } from "./jobRepository";
import { evaluateProviderStatusUpdate } from "./sequence";
import { isTerminalStatus } from "./transitions";
import type { AnalysisJob, JobEventSource } from "./types";

function logEvent(event: string, fields: Record<string, string | number | boolean | undefined>): void {
  const parts = Object.entries(fields)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${v}`);
  console.log(`[chelcoach-analysis] event=${event} ${parts.join(" ")}`);
}

export interface AnalysisJobSyncResult {
  job: AnalysisJob;
  status: ApplicationAnalysisStatus;
  synchronized: boolean;
  degraded: boolean;
}

function pollFromStatus(status: string, pollAfterMs: number | null | undefined): number | null {
  if (isTerminalStatus(status as AnalysisJob["canonicalStatus"])) return null;
  if (status === "awaiting_player_confirmation") return null;
  if (pollAfterMs === null) return null;
  const n = pollAfterMs ?? 2000;
  return Math.min(10_000, Math.max(200, n));
}

export function toPublicJobStatus(
  job: AnalysisJob,
  opts?: {
    degraded?: boolean;
    pollAfterMs?: number | null;
    omitProvider?: boolean;
    messageOverride?: string;
  },
): ApplicationAnalysisStatus {
  const terminal = isTerminalStatus(job.canonicalStatus);
  const pollAfterMs =
    opts?.pollAfterMs !== undefined
      ? opts.pollAfterMs
      : pollFromStatus(job.canonicalStatus, job.nextSyncAfter ? 2000 : null);
  return applicationAnalysisStatusSchema.parse({
    applicationRequestId: job.applicationRequestId,
    uploadId: job.uploadId,
    ...(opts?.omitProvider && process.env.NODE_ENV === "production"
      ? {}
      : { provider: job.provider }),
    status: job.canonicalStatus,
    statusLabel: analysisStatusLabel(job.canonicalStatus),
    sequenceNumber: job.statusSequenceNumber,
    pollAfterMs,
    userActionRequired: job.confirmationRequired || job.canonicalStatus === "awaiting_player_confirmation",
    terminal,
    reportReady: job.reportAvailable,
    reportAvailable: job.reportAvailable,
    cancellationAvailable: !terminal && job.canonicalStatus !== "completed",
    degraded: opts?.degraded ?? false,
    message: opts?.messageOverride ?? job.safeErrorMessage,
    errorCode: opts?.degraded ? "PROVIDER_UNAVAILABLE" : job.safeErrorCode,
    errorMessage: opts?.messageOverride ?? job.safeErrorMessage,
    acceptedAt: job.acceptedAt,
    updatedAt: job.updatedAt,
    simulatorMode:
      job.provider === "simulator" && process.env.NODE_ENV !== "production" ? true : undefined,
  });
}

function providerForJob(job: AnalysisJob) {
  try {
    return createScottyProviderForMode(job.provider);
  } catch (err) {
    throw new ProviderError(
      "PROVIDER_UNAVAILABLE",
      err instanceof Error ? err.message : "Recorded provider unavailable",
      "provider_unavailable",
      { provider: job.provider, retryable: true },
    );
  }
}

async function persistReportFromProvider(
  job: AnalysisJob,
  report: ScottyReport,
  sequenceNumber: number,
  providerSequenceNumber: number,
  eventSource: JobEventSource,
): Promise<AnalysisJob> {
  const validated = scottyReportSchema.parse(report);
  if (validated.uploadId !== job.uploadId) {
    throw new ProviderError(
      "REPORT_VALIDATION_FAILED",
      "Report upload ID does not match the application job.",
      "invalid_response",
      { provider: job.provider, retryable: false },
    );
  }
  if (job.externalJobId && validated.jobId !== job.externalJobId) {
    throw new ProviderError(
      "REPORT_VALIDATION_FAILED",
      "Report job ID does not match the provider job.",
      "invalid_response",
      { provider: job.provider, retryable: false },
    );
  }
  // Platform / control scheme continuity.
  if (validated.controlGuidance.some((g) => g.platform !== job.uploadContext.playerContext.platform)) {
    throw new ProviderError(
      "REPORT_VALIDATION_FAILED",
      "Report platform does not match uploaded player context.",
      "invalid_response",
      { provider: job.provider, retryable: false },
    );
  }

  const now = new Date().toISOString();
  const persisted = {
    id: randomUUID(),
    applicationRequestId: job.applicationRequestId,
    jobId: job.id,
    externalJobId: job.externalJobId ?? validated.jobId,
    uploadId: job.uploadId,
    ownerId: job.ownerId,
    provider: job.provider,
    contractVersion: validated.contractVersion,
    reportVersion: validated.reportVersion,
    rubricVersion: validated.rubricVersion,
    strategyKnowledgeVersion: validated.strategyKnowledgeVersion,
    controlKnowledgeVersion: validated.controlKnowledgeVersion,
    report: validated,
    contentChecksum: checksumReport(validated),
    schemaValidatedAt: now,
    providerGeneratedAt: validated.generatedAt,
    persistedAt: now,
  };

  return getAnalysisJobRepository().completeWithReport({
    applicationRequestId: job.applicationRequestId,
    expectedVersion: job.version,
    report: persisted,
    completedAt: now,
    statusSequenceNumber: sequenceNumber,
    providerSequenceNumber,
    eventSource,
  });
}

export async function synchronizeJob(input: {
  ownerId?: string;
  applicationRequestId: string;
  trigger: "user_poll" | "reconciliation" | "callback";
  force?: boolean;
}): Promise<AnalysisJobSyncResult> {
  const repo = getAnalysisJobRepository();
  const job = input.ownerId
    ? await repo.getOwnedJob(input.ownerId, input.applicationRequestId)
    : await repo.getByApplicationRequestId(input.applicationRequestId);
  if (!job) {
    throw Object.assign(new Error("Analysis request not found."), {
      httpStatus: 404,
      code: "UPLOAD_NOT_FOUND",
    });
  }

  const eventSource: JobEventSource =
    input.trigger === "callback"
      ? "provider_callback"
      : input.trigger === "reconciliation"
        ? "reconciliation"
        : "provider_poll";

  // Skip sync if not due (unless forced / reconciliation / confirmation pause still needs report fetch).
  const due =
    input.force ||
    input.trigger === "reconciliation" ||
    job.reconciliationRequired ||
    job.submissionAcceptanceState === "acceptance_unknown" ||
    !job.nextSyncAfter ||
    new Date(job.nextSyncAfter).getTime() <= Date.now();

  if (!due || !job.externalJobId) {
    return {
      job,
      status: toPublicJobStatus(job),
      synchronized: false,
      degraded: false,
    };
  }

  logEvent("status_synchronization_started", {
    applicationRequestId: job.applicationRequestId,
    uploadId: job.uploadId,
    provider: job.provider,
    trigger: input.trigger,
  });

  let provider;
  try {
    provider = providerForJob(job);
  } catch {
    logEvent("provider_unavailable", {
      applicationRequestId: job.applicationRequestId,
      provider: job.provider,
      errorCode: "PROVIDER_UNAVAILABLE",
    });
    // Preserve durable job — never remap provider or invent a report.
    return {
      job,
      status: toPublicJobStatus(job, {
        degraded: true,
        pollAfterMs: 5000,
        messageOverride:
          "The analysis provider is temporarily unavailable. Showing last known status.",
      }),
      synchronized: false,
      degraded: true,
    };
  }

  try {
    const raw = await provider.getJob({
      externalJobId: job.externalJobId,
      applicationRequestId: job.applicationRequestId,
    });
    const incoming = scottyJobStatusResponseSchema.parse(raw);
    const decision = evaluateProviderStatusUpdate({ currentJob: job, incoming });

    if (decision.decision === "stale") {
      logEvent("stale_provider_state_ignored", {
        applicationRequestId: job.applicationRequestId,
        sequenceNumber: incoming.sequenceNumber,
      });
      return { job, status: toPublicJobStatus(job), synchronized: true, degraded: false };
    }
    if (decision.decision === "idempotent") {
      return { job, status: toPublicJobStatus(job, { pollAfterMs: pollFromStatus(incoming.status, incoming.pollAfterMs ?? null) }), synchronized: true, degraded: false };
    }
    if (decision.decision === "conflict" || decision.decision === "reject") {
      logEvent("status_sync_rejected", {
        applicationRequestId: job.applicationRequestId,
        errorCode: "INVALID_REQUEST",
        reason: decision.reason,
      });
      return { job, status: toPublicJobStatus(job, { degraded: true }), synchronized: false, degraded: true };
    }

    if (decision.decision === "requires_report_fetch") {
      try {
        const report = await provider.getReport({
          externalJobId: job.externalJobId,
          applicationRequestId: job.applicationRequestId,
        });
        const completed = await persistReportFromProvider(
          job,
          report,
          decision.nextSequence,
          incoming.sequenceNumber ?? decision.nextSequence,
          eventSource,
        );
        logEvent("report_persisted", {
          applicationRequestId: completed.applicationRequestId,
          uploadId: completed.uploadId,
          provider: completed.provider,
          sequenceNumber: completed.statusSequenceNumber,
        });
        return {
          job: completed,
          status: toPublicJobStatus(completed, { pollAfterMs: null }),
          synchronized: true,
          degraded: false,
        };
      } catch (err) {
        const code =
          err instanceof ProviderError ? err.code : "REPORT_VALIDATION_FAILED";
        logEvent("report_validation_failed", {
          applicationRequestId: job.applicationRequestId,
          errorCode: code,
        });
        const failed = await repo.markFailed({
          applicationRequestId: job.applicationRequestId,
          expectedVersion: job.version,
          safeErrorCode: code,
          safeErrorMessage:
            err instanceof Error ? err.message : "Report validation failed",
          retryable: code === "REPORT_NOT_READY" || code === "ANALYSIS_TIMEOUT",
          reconciliationRequired: true,
          statusSequenceNumber: decision.nextSequence,
          eventSource,
        });
        return {
          job: failed,
          status: toPublicJobStatus(failed),
          synchronized: true,
          degraded: false,
        };
      }
    }

    // advance
    const advanced = await repo.updateFromProviderStatus({
      applicationRequestId: job.applicationRequestId,
      expectedVersion: job.version,
      canonicalStatus: incoming.status,
      providerStatus: incoming.status,
      statusSequenceNumber: decision.nextSequence,
      providerSequenceNumber: incoming.sequenceNumber ?? decision.nextSequence,
      confirmationRequired:
        incoming.userActionRequired === true ||
        incoming.status === "awaiting_player_confirmation",
      safeErrorCode: incoming.errorCode,
      safeErrorMessage: incoming.errorMessage,
      retryable: false,
      nextSyncAfter:
        pollFromStatus(incoming.status, incoming.pollAfterMs ?? null) === null
          ? null
          : new Date(
              Date.now() + (pollFromStatus(incoming.status, incoming.pollAfterMs ?? null) ?? 2000),
            ).toISOString(),
      message: incoming.message,
      eventSource,
      startedAt: incoming.status !== "queued" ? new Date().toISOString() : undefined,
    });
    logEvent("state_advanced", {
      applicationRequestId: advanced.applicationRequestId,
      status: advanced.canonicalStatus,
      sequenceNumber: advanced.statusSequenceNumber,
    });
    return {
      job: advanced,
      status: toPublicJobStatus(advanced, {
        pollAfterMs: pollFromStatus(advanced.canonicalStatus, incoming.pollAfterMs ?? null),
      }),
      synchronized: true,
      degraded: false,
    };
  } catch (err) {
    if (err instanceof OptimisticConcurrencyError) {
      const fresh = await repo.getByApplicationRequestId(job.applicationRequestId);
      return {
        job: fresh ?? job,
        status: toPublicJobStatus(fresh ?? job),
        synchronized: false,
        degraded: false,
      };
    }
    logEvent("provider_unavailable", {
      applicationRequestId: job.applicationRequestId,
      provider: job.provider,
      errorCode: err instanceof ProviderError ? err.code : "PROVIDER_UNAVAILABLE",
    });
    return {
      job,
      status: toPublicJobStatus(job, { degraded: true, pollAfterMs: 5000 }),
      synchronized: false,
      degraded: true,
    };
  }
}

/** Prefer recorded job provider; fall back to global only for brand-new submissions. */
export function getProviderForSubmission(): ReturnType<typeof getScottyProvider> {
  return getScottyProvider();
}

export function getDefaultProviderMode(): AnalysisJob["provider"] {
  return loadScottyProviderConfig().provider;
}
