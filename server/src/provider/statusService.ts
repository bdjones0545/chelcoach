/**
 * Provider-independent analysis status / report / confirm / cancel (Steps 5–6).
 * Reads and writes durable application jobs; provider sync is centralized.
 */
import {
  scottyReportSchema,
  type ApplicationAnalysisStatus,
  type ScottyErrorCode,
  type ScottyReport,
} from "../scottyContract";
import { getUploadRepository } from "../uploads/repository";
import { ProviderError } from "./errors";
import { createScottyProviderForMode } from "./factory";
import { getAnalysisJobRepository, OptimisticConcurrencyError } from "./jobs/jobRepository";
import { synchronizeJob, toPublicJobStatus } from "./jobs/syncService";
import { isTerminalStatus } from "./jobs/transitions";

export class AnalysisStatusError extends Error {
  constructor(
    public httpStatus: number,
    public code: ScottyErrorCode | "INVALID_REQUEST",
    message: string,
  ) {
    super(message);
    this.name = "AnalysisStatusError";
  }
}

function logEvent(event: string, fields: Record<string, string | number | boolean | undefined>): void {
  const parts = Object.entries(fields)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${v}`);
  console.log(`[chelcoach-analysis] event=${event} ${parts.join(" ")}`);
}

function mapProviderError(err: unknown): never {
  if (err instanceof AnalysisStatusError) throw err;
  if (err instanceof ProviderError) {
    const status =
      err.code === "ANALYSIS_TIMEOUT"
        ? 504
        : err.code === "RATE_LIMITED"
          ? 429
          : err.code === "FORBIDDEN" || err.code === "UNAUTHORIZED"
            ? 403
            : err.code === "REPORT_NOT_READY" || err.code === "PLAYER_IDENTITY_UNCONFIRMED"
              ? 409
              : err.code === "JOB_CANCELLED"
                ? 410
                : err.code === "PROVIDER_UNAVAILABLE" || err.code === "PROVIDER_MISCONFIGURED"
                  ? 503
                  : 422;
    throw new AnalysisStatusError(status, err.code, err.message);
  }
  throw err;
}

async function loadOwnedJob(ownerId: string, applicationRequestId: string) {
  const any = await getAnalysisJobRepository().getByApplicationRequestId(applicationRequestId);
  if (!any) {
    throw new AnalysisStatusError(404, "UPLOAD_NOT_FOUND", "Analysis request not found.");
  }
  if (any.ownerId !== ownerId) {
    throw new AnalysisStatusError(403, "FORBIDDEN", "You don't have access to this analysis.");
  }
  const job = any;
  const upload = await getUploadRepository().get(job.uploadId);
  if (!upload || upload.ownerId !== ownerId) {
    throw new AnalysisStatusError(403, "FORBIDDEN", "You don't have access to this analysis.");
  }
  // Absolute retention: stop transfer attempts when media is gone.
  if (
    (upload.uploadStatus === "deleted" || upload.uploadStatus === "expired") &&
    !job.reportAvailable &&
    !isTerminalStatus(job.canonicalStatus)
  ) {
    await getAnalysisJobRepository()
      .markFailed({
        applicationRequestId: job.applicationRequestId,
        expectedVersion: job.version,
        safeErrorCode: "MEDIA_ALREADY_DELETED",
        safeErrorMessage: "Source media is no longer available for this analysis.",
        retryable: false,
        reconciliationRequired: false,
        eventSource: "system",
      })
      .catch(() => undefined);
  }
  return job;
}

export async function getAnalysisStatus(input: {
  ownerId: string;
  applicationRequestId: string;
}): Promise<ApplicationAnalysisStatus> {
  await loadOwnedJob(input.ownerId, input.applicationRequestId);
  try {
    const sync = await synchronizeJob({
      ownerId: input.ownerId,
      applicationRequestId: input.applicationRequestId,
      trigger: "user_poll",
    });
    // Public response must omit secrets / fingerprints / URLs.
    const json = JSON.stringify(sync.status);
    if (
      json.includes("idempotencyKey") ||
      json.includes("requestFingerprint") ||
      json.includes("SCOTTY_BASE_URL") ||
      json.includes("storageObjectKey")
    ) {
      throw new AnalysisStatusError(500, "INVALID_REQUEST", "Unsafe fields leaked into status response.");
    }
    return sync.status;
  } catch (err) {
    if ((err as { httpStatus?: number }).httpStatus) {
      throw new AnalysisStatusError(
        (err as AnalysisStatusError).httpStatus ?? 500,
        ((err as AnalysisStatusError).code as ScottyErrorCode) ?? "ANALYSIS_FAILED",
        err instanceof Error ? err.message : "Unexpected error.",
      );
    }
    mapProviderError(err);
  }
}

export async function getAnalysisReport(input: {
  ownerId: string;
  applicationRequestId: string;
}): Promise<ScottyReport> {
  const job = await loadOwnedJob(input.ownerId, input.applicationRequestId);
  const repo = getAnalysisJobRepository();
  const stored = await repo.getReportByApplicationRequestId(job.applicationRequestId);
  if (stored) {
    logEvent("analysis_report_read", {
      applicationRequestId: job.applicationRequestId,
      uploadId: job.uploadId,
      source: "database",
    });
    return scottyReportSchema.parse(stored.report);
  }

  // Not persisted yet — try one sync (may fetch+persist). Do not call provider after persist.
  if (!isTerminalStatus(job.canonicalStatus) || job.canonicalStatus === "completed") {
    const sync = await synchronizeJob({
      ownerId: input.ownerId,
      applicationRequestId: input.applicationRequestId,
      trigger: "user_poll",
      force: true,
    });
    const again = await repo.getReportByApplicationRequestId(sync.job.applicationRequestId);
    if (again) return scottyReportSchema.parse(again.report);
  }

  if (job.canonicalStatus === "awaiting_player_confirmation" || job.confirmationRequired) {
    throw new AnalysisStatusError(
      409,
      "PLAYER_IDENTITY_UNCONFIRMED",
      "Confirm which player you controlled before continuing.",
    );
  }
  if (job.canonicalStatus === "cancelled") {
    throw new AnalysisStatusError(410, "JOB_CANCELLED", "This analysis job was cancelled.");
  }
  if (job.canonicalStatus === "failed" && job.safeErrorCode) {
    throw new AnalysisStatusError(422, job.safeErrorCode, job.safeErrorMessage ?? "Analysis failed.");
  }
  throw new AnalysisStatusError(409, "REPORT_NOT_READY", "The coaching report is not ready yet.");
}

export async function confirmAnalysisPlayer(input: {
  ownerId: string;
  applicationRequestId: string;
  selectedCandidateId: string;
}): Promise<ApplicationAnalysisStatus> {
  const job = await loadOwnedJob(input.ownerId, input.applicationRequestId);
  if (!job.externalJobId) {
    throw new AnalysisStatusError(409, "UPLOAD_NOT_READY", "Analysis has not been accepted yet.");
  }
  const repo = getAnalysisJobRepository();
  try {
    const confirmedAt = new Date().toISOString();
    const updated = await repo.markRemoteConfirmation(
      job.applicationRequestId,
      job.version,
      input.selectedCandidateId,
      confirmedAt,
    );
    logEvent("player_confirmation_persisted", {
      applicationRequestId: job.applicationRequestId,
      uploadId: job.uploadId,
    });
    const provider = createScottyProviderForMode(updated.provider);
    if (!provider.confirmPlayer) {
      throw new AnalysisStatusError(
        501,
        "INVALID_REQUEST",
        "This analysis provider does not support remote player confirmation.",
      );
    }
    await provider.confirmPlayer({
      externalJobId: updated.externalJobId!,
      applicationRequestId: updated.applicationRequestId,
      selectedCandidateId: input.selectedCandidateId,
      confirmedAt,
    });
    const sync = await synchronizeJob({
      ownerId: input.ownerId,
      applicationRequestId: input.applicationRequestId,
      trigger: "user_poll",
      force: true,
    });
    return sync.status;
  } catch (err) {
    if (err instanceof OptimisticConcurrencyError) {
      return getAnalysisStatus(input);
    }
    mapProviderError(err);
  }
}

export async function cancelAnalysis(input: {
  ownerId: string;
  applicationRequestId: string;
  reason?: string;
}): Promise<ApplicationAnalysisStatus> {
  const job = await loadOwnedJob(input.ownerId, input.applicationRequestId);
  const repo = getAnalysisJobRepository();

  if (job.canonicalStatus === "cancelled") {
    return toPublicJobStatus(job, { pollAfterMs: null });
  }
  if (job.canonicalStatus === "completed") {
    throw new AnalysisStatusError(422, "INVALID_REQUEST", "Completed jobs cannot be cancelled.");
  }
  if (!job.externalJobId) {
    throw new AnalysisStatusError(409, "UPLOAD_NOT_READY", "Analysis has not been accepted yet.");
  }

  try {
    const requested = await repo.markCancellationRequested({
      applicationRequestId: job.applicationRequestId,
      expectedVersion: job.version,
      requestedAt: new Date().toISOString(),
    });
    logEvent("cancellation_requested", {
      applicationRequestId: job.applicationRequestId,
      uploadId: job.uploadId,
    });

    const provider = createScottyProviderForMode(requested.provider);
    if (!provider.cancelJob) {
      throw new AnalysisStatusError(
        501,
        "INVALID_REQUEST",
        "This analysis provider does not support cancellation.",
      );
    }

    try {
      const cancel = await provider.cancelJob({
        externalJobId: requested.externalJobId!,
        applicationRequestId: requested.applicationRequestId,
        reason: input.reason,
      });
      const cancelled = await repo.markCancelled({
        applicationRequestId: requested.applicationRequestId,
        expectedVersion: requested.version,
        cancelledAt: cancel.cancelledAt,
        statusSequenceNumber: Math.max(requested.statusSequenceNumber + 1, 99),
        eventSource: "user_cancellation",
      });
      logEvent("cancellation_confirmed", {
        applicationRequestId: cancelled.applicationRequestId,
        uploadId: cancelled.uploadId,
      });
      return toPublicJobStatus(cancelled, { pollAfterMs: null });
    } catch {
      // Uncertain cancellation — keep cancellationRequested; reconciliation will retry.
      logEvent("cancellation_uncertain", {
        applicationRequestId: requested.applicationRequestId,
        uploadId: requested.uploadId,
      });
      const fresh = await repo.getByApplicationRequestId(requested.applicationRequestId);
      return toPublicJobStatus(fresh ?? requested, {
        degraded: true,
        pollAfterMs: 3000,
        messageOverride: "Cancellation submitted; confirming with the analysis provider.",
      });
    }
  } catch (err) {
    if (err instanceof OptimisticConcurrencyError) {
      return getAnalysisStatus({
        ownerId: input.ownerId,
        applicationRequestId: input.applicationRequestId,
      });
    }
    mapProviderError(err);
  }
}
