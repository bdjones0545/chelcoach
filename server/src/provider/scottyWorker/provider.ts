/**
 * ScottyWorkerProvider — the production analysis provider.
 *
 * Submission creates a durable worker job; `getJob`/`getReport` read that row; the actual work
 * (frame sampling + vision model + report assembly) is done by `runScottyWorkerBatch`, driven by
 * the platform scheduler. Nothing here reaches the network, so the provider boundary stays
 * cheap for the polling path.
 */
import { createHash } from "node:crypto";
import { isVisionModelConfigured } from "../../ai/modelClient";
import {
  scottyAnalysisSubmissionSchema,
  scottyCancelResponseSchema,
  scottyJobStatusResponseSchema,
  scottyProviderHealthSchema,
  scottyProviderJobReceiptSchema,
  scottyReportSchema,
  type ScottyAnalysisSubmission,
  type ScottyCancelRequest,
  type ScottyCancelResponse,
  type ScottyJobLookup,
  type ScottyJobStatus,
  type ScottyJobStatusResponse,
  type ScottyProviderHealth,
  type ScottyProviderJobReceipt,
  type ScottyReport,
  type ScottyReportLookup,
} from "../../scottyContract";
import { ProviderError } from "../errors";
import { computeSubmissionFingerprint } from "../fakeProvider";
import type { ScottyProvider } from "../types";
import { getScottyWorkerJobRepository, type ScottyWorkerJobRepository } from "./repository";
import type { ScottyWorkerJob } from "./types";

export const SCOTTY_WORKER_POLL_MS = 3000;
const DEFAULT_MAX_ATTEMPTS = 3;

const STATUS_MESSAGES: Partial<Record<ScottyJobStatus, string>> = {
  queued: "Waiting for the film room to pick up your clip.",
  extracting_frames: "Pulling representative frames from your gameplay.",
  analyzing_gameplay: "Scotty is reviewing your shifts.",
  validating_report: "Checking the coaching report against the rubric.",
  finalizing: "Finalizing your report.",
  completed: "Your coaching report is ready.",
  failed: "Analysis could not be completed.",
  cancelled: "Analysis was cancelled.",
};

function logEvent(event: string, fields: Record<string, string | number | boolean | undefined>): void {
  const parts = Object.entries(fields)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${v}`);
  console.log(`[chelcoach-scotty-worker] event=${event} ${parts.join(" ")}`);
}

export function isTerminalWorkerStatus(status: ScottyJobStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

export function workerJobToStatus(job: ScottyWorkerJob, pollAfterMs = SCOTTY_WORKER_POLL_MS): ScottyJobStatusResponse {
  const terminal = isTerminalWorkerStatus(job.status);
  return scottyJobStatusResponseSchema.parse({
    contractVersion: job.contractVersion,
    jobId: job.externalJobId,
    uploadId: job.uploadId,
    provider: "scotty_worker",
    externalScottyJobId: job.externalJobId,
    applicationRequestId: job.applicationRequestId,
    status: job.status,
    sequenceNumber: job.sequenceNumber,
    pollAfterMs: terminal ? null : pollAfterMs,
    userActionRequired: false,
    terminal,
    message: job.errorMessage ?? STATUS_MESSAGES[job.status],
    errorCode: job.errorCode,
    errorMessage: job.errorMessage,
    reportReady: job.status === "completed" && Boolean(job.report),
    enteredAt: job.updatedAt,
    updatedAt: job.updatedAt,
    playerContext: job.submission.playerContext,
    gameContext: job.submission.gameContext,
  });
}

export class ScottyWorkerProvider implements ScottyProvider {
  readonly mode = "scotty_worker" as const;
  readonly canServeProductionTraffic: boolean;

  constructor(
    private opts: {
      repo?: ScottyWorkerJobRepository;
      modelConfigured?: boolean;
      maxAttempts?: number;
      /** Advisory client poll interval while a job is active (tests shorten it). */
      pollAfterMs?: number;
    } = {},
  ) {
    // Capability is declared from the one thing that makes real analysis possible: model
    // credentials. Frame sampling failures surface per job, never as a silent fallback.
    this.canServeProductionTraffic = opts.modelConfigured ?? isVisionModelConfigured();
  }

  private repo(): ScottyWorkerJobRepository {
    return this.opts.repo ?? getScottyWorkerJobRepository();
  }

  private pollMs(): number {
    return this.opts.pollAfterMs ?? SCOTTY_WORKER_POLL_MS;
  }

  async submitAnalysis(input: ScottyAnalysisSubmission): Promise<ScottyProviderJobReceipt> {
    const parsed = scottyAnalysisSubmissionSchema.parse(input);
    const fingerprint = computeSubmissionFingerprint(parsed);
    const existing = await this.repo().getByIdempotencyKey(parsed.idempotencyKey);
    if (existing) {
      if (existing.requestFingerprint !== fingerprint) {
        throw new ProviderError(
          "IDEMPOTENCY_CONFLICT",
          "Idempotency key reused with different request fingerprint.",
          "validation",
          { provider: "scotty_worker", retryable: false, requestId: parsed.requestId },
        );
      }
      logEvent("duplicate_reused", {
        applicationRequestId: existing.applicationRequestId,
        externalJobId: existing.externalJobId,
      });
      return scottyProviderJobReceiptSchema.parse({
        contractVersion: existing.contractVersion,
        provider: "scotty_worker",
        externalJobId: existing.externalJobId,
        applicationRequestId: existing.applicationRequestId,
        idempotencyKey: existing.idempotencyKey,
        acceptedAt: existing.acceptedAt,
        status: existing.status,
        pollAfterMs: this.pollMs(),
      });
    }

    const now = new Date().toISOString();
    const externalJobId = `sw_${createHash("sha256").update(parsed.idempotencyKey).digest("hex").slice(0, 20)}`;
    const job = await this.repo().create({
      externalJobId,
      applicationRequestId: parsed.requestId,
      uploadId: parsed.uploadId,
      ownerReference: parsed.ownerReference,
      idempotencyKey: parsed.idempotencyKey,
      requestFingerprint: fingerprint,
      contractVersion: parsed.contractVersion,
      submission: parsed,
      status: "queued",
      sequenceNumber: 1,
      attemptCount: 0,
      maxAttempts: this.opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
      acceptedAt: now,
      retryable: false,
      createdAt: now,
      updatedAt: now,
    });
    logEvent("job_created", {
      applicationRequestId: job.applicationRequestId,
      externalJobId: job.externalJobId,
      uploadId: job.uploadId,
      mediaClassification: parsed.mediaClassification,
    });
    return scottyProviderJobReceiptSchema.parse({
      contractVersion: job.contractVersion,
      provider: "scotty_worker",
      externalJobId: job.externalJobId,
      applicationRequestId: job.applicationRequestId,
      idempotencyKey: job.idempotencyKey,
      acceptedAt: job.acceptedAt,
      status: job.status,
      pollAfterMs: SCOTTY_WORKER_POLL_MS,
    });
  }

  private async requireJob(lookup: { externalJobId: string; applicationRequestId?: string }): Promise<ScottyWorkerJob> {
    const job = await this.repo().getByExternalJobId(lookup.externalJobId);
    if (!job) {
      throw new ProviderError("ANALYSIS_FAILED", "Unknown worker job.", "validation", {
        provider: "scotty_worker",
        retryable: false,
      });
    }
    if (lookup.applicationRequestId && lookup.applicationRequestId !== job.applicationRequestId) {
      throw new ProviderError("FORBIDDEN", "Request mismatch.", "authorization", {
        provider: "scotty_worker",
        retryable: false,
      });
    }
    return job;
  }

  async getJob(input: ScottyJobLookup): Promise<ScottyJobStatusResponse> {
    return workerJobToStatus(await this.requireJob(input), this.pollMs());
  }

  async getReport(input: ScottyReportLookup): Promise<ScottyReport> {
    const job = await this.requireJob(input);
    if (job.status === "cancelled") {
      throw new ProviderError("JOB_CANCELLED", "This analysis job was cancelled.", "permanent_failure", {
        provider: "scotty_worker",
        retryable: false,
      });
    }
    if (job.status === "failed") {
      throw new ProviderError(job.errorCode ?? "ANALYSIS_FAILED", job.errorMessage ?? "Analysis failed.", "permanent_failure", {
        provider: "scotty_worker",
        retryable: false,
      });
    }
    if (job.status !== "completed" || !job.report) {
      throw new ProviderError("REPORT_NOT_READY", "The coaching report is not ready yet.", "validation", {
        provider: "scotty_worker",
        retryable: true,
      });
    }
    return scottyReportSchema.parse(job.report);
  }

  async cancelJob(input: ScottyCancelRequest): Promise<ScottyCancelResponse> {
    const job = await this.requireJob(input);
    if (job.status === "completed") {
      throw new ProviderError("INVALID_REQUEST", "Completed jobs cannot be cancelled.", "validation", {
        provider: "scotty_worker",
        retryable: false,
      });
    }
    if (job.cancelledAt || job.status === "cancelled") {
      return scottyCancelResponseSchema.parse({
        externalJobId: job.externalJobId,
        status: "cancelled",
        cancelledAt: job.cancelledAt ?? job.updatedAt,
      });
    }
    const now = new Date().toISOString();
    const updated = await this.repo().update(job.externalJobId, {
      status: "cancelled",
      sequenceNumber: job.sequenceNumber + 1,
      cancelledAt: now,
      cancelReason: input.reason ?? "Cancelled by user",
      claimExpiresAt: undefined,
      workerId: undefined,
    });
    logEvent("job_cancelled", { applicationRequestId: updated.applicationRequestId, externalJobId: updated.externalJobId });
    return scottyCancelResponseSchema.parse({
      externalJobId: updated.externalJobId,
      status: "cancelled",
      cancelledAt: updated.cancelledAt ?? now,
    });
  }

  async health(): Promise<ScottyProviderHealth> {
    const active = await this.repo().listActive();
    const configured = this.canServeProductionTraffic;
    return scottyProviderHealthSchema.parse({
      provider: "scotty_worker",
      configured,
      reachable: configured,
      contractCompatible: true,
      status: configured ? (active.length > 25 ? "degraded" : "healthy") : "misconfigured",
      checkedAt: new Date().toISOString(),
      message: configured
        ? `Scotty worker ready (${active.length} active job${active.length === 1 ? "" : "s"})`
        : "Vision model credentials are not configured",
    });
  }
}
