/**
 * Provider-independent analysis status / report / confirm / cancel (Step 5).
 * Ownership is enforced via submission records + upload owner.
 * Full durable job persistence remains Step 6.
 */
import {
  applicationAnalysisStatusSchema,
  scottyJobStatusResponseSchema,
  scottyReportSchema,
  type ApplicationAnalysisStatus,
  type ScottyErrorCode,
  type ScottyReport,
} from "../scottyContract";
import { getUploadRepository } from "../uploads/repository";
import { ProviderError } from "./errors";
import { getScottyProvider } from "./factory";
import { getAnalysisSubmissionRepository } from "./submissionRepository";

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

async function loadOwnedSubmission(ownerId: string, applicationRequestId: string) {
  const submissions = getAnalysisSubmissionRepository();
  const record = await submissions.getByRequestId(applicationRequestId);
  if (!record) {
    throw new AnalysisStatusError(404, "UPLOAD_NOT_FOUND", "Analysis request not found.");
  }
  if (record.ownerId !== ownerId) {
    throw new AnalysisStatusError(403, "FORBIDDEN", "You don't have access to this analysis.");
  }
  const upload = await getUploadRepository().get(record.uploadId);
  if (!upload || upload.ownerId !== ownerId) {
    throw new AnalysisStatusError(403, "FORBIDDEN", "You don't have access to this analysis.");
  }
  if (!record.externalJobId) {
    throw new AnalysisStatusError(409, "UPLOAD_NOT_READY", "Analysis has not been accepted yet.");
  }
  return { record, upload };
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

export async function getAnalysisStatus(input: {
  ownerId: string;
  applicationRequestId: string;
}): Promise<ApplicationAnalysisStatus> {
  const { record } = await loadOwnedSubmission(input.ownerId, input.applicationRequestId);
  const provider = getScottyProvider();

  try {
    const raw = await provider.getJob({
      externalJobId: record.externalJobId!,
      applicationRequestId: record.applicationRequestId,
    });
    const status = scottyJobStatusResponseSchema.parse(raw);

    // Reject status regression relative to last known sequence.
    const prevSeq = record.lastSequenceNumber ?? 0;
    const nextSeq = status.sequenceNumber ?? prevSeq;
    if (nextSeq < prevSeq) {
      logEvent("status_regression_ignored", {
        applicationRequestId: record.applicationRequestId,
        previousSequence: prevSeq,
        incomingSequence: nextSeq,
      });
      return applicationAnalysisStatusSchema.parse({
        applicationRequestId: record.applicationRequestId,
        uploadId: record.uploadId,
        provider: record.provider,
        status: record.lastKnownStatus,
        sequenceNumber: prevSeq || 1,
        pollAfterMs: status.pollAfterMs ?? null,
        userActionRequired: record.userActionRequired ?? false,
        terminal: ["completed", "failed", "cancelled"].includes(record.lastKnownStatus),
        reportReady: record.reportReady ?? false,
        message: status.message,
        errorCode: status.errorCode,
        errorMessage: status.errorMessage,
        acceptedAt: record.acceptedAt,
        updatedAt: record.updatedAt,
        simulatorMode:
          record.provider === "simulator" && process.env.NODE_ENV !== "production" ? true : undefined,
      });
    }

    await getAnalysisSubmissionRepository().update(record.applicationRequestId, {
      lastKnownStatus: status.status,
      lastSequenceNumber: nextSeq,
      userActionRequired: status.userActionRequired ?? false,
      reportReady: status.reportReady,
      confirmationRequired: status.status === "awaiting_player_confirmation",
      cancelledAt: status.status === "cancelled" ? status.updatedAt : record.cancelledAt,
    });

    logEvent("analysis_status_read", {
      applicationRequestId: record.applicationRequestId,
      uploadId: record.uploadId,
      status: status.status,
      sequenceNumber: nextSeq,
    });

    return applicationAnalysisStatusSchema.parse({
      applicationRequestId: record.applicationRequestId,
      uploadId: record.uploadId,
      provider: status.provider,
      status: status.status,
      sequenceNumber: nextSeq || 1,
      pollAfterMs: status.pollAfterMs ?? null,
      userActionRequired: status.userActionRequired ?? false,
      terminal: status.terminal ?? ["completed", "failed", "cancelled"].includes(status.status),
      reportReady: status.reportReady,
      message: status.message,
      errorCode: status.errorCode,
      errorMessage: status.errorMessage,
      acceptedAt: record.acceptedAt,
      updatedAt: status.updatedAt,
      simulatorMode:
        status.provider === "simulator" && process.env.NODE_ENV !== "production" ? true : undefined,
    });
  } catch (err) {
    mapProviderError(err);
  }
}

export async function getAnalysisReport(input: {
  ownerId: string;
  applicationRequestId: string;
}): Promise<ScottyReport> {
  const { record } = await loadOwnedSubmission(input.ownerId, input.applicationRequestId);
  const provider = getScottyProvider();
  try {
    const raw = await provider.getReport({
      externalJobId: record.externalJobId!,
      applicationRequestId: record.applicationRequestId,
    });
    const report = scottyReportSchema.parse(raw);
    await getAnalysisSubmissionRepository().update(record.applicationRequestId, {
      reportReady: true,
      lastKnownStatus: "completed",
    });
    logEvent("analysis_report_read", {
      applicationRequestId: record.applicationRequestId,
      uploadId: record.uploadId,
    });
    return report;
  } catch (err) {
    mapProviderError(err);
  }
}

export async function confirmAnalysisPlayer(input: {
  ownerId: string;
  applicationRequestId: string;
  selectedCandidateId: string;
}): Promise<ApplicationAnalysisStatus> {
  const { record } = await loadOwnedSubmission(input.ownerId, input.applicationRequestId);
  const provider = getScottyProvider();
  if (!provider.confirmPlayer) {
    throw new AnalysisStatusError(
      501,
      "INVALID_REQUEST",
      "This analysis provider does not support remote player confirmation.",
    );
  }
  try {
    await provider.confirmPlayer({
      externalJobId: record.externalJobId!,
      applicationRequestId: record.applicationRequestId,
      selectedCandidateId: input.selectedCandidateId,
      confirmedAt: new Date().toISOString(),
    });
    logEvent("analysis_confirmation_submitted", {
      applicationRequestId: record.applicationRequestId,
      uploadId: record.uploadId,
    });
    return getAnalysisStatus({
      ownerId: input.ownerId,
      applicationRequestId: input.applicationRequestId,
    });
  } catch (err) {
    mapProviderError(err);
  }
}

export async function cancelAnalysis(input: {
  ownerId: string;
  applicationRequestId: string;
  reason?: string;
}): Promise<ApplicationAnalysisStatus> {
  const { record } = await loadOwnedSubmission(input.ownerId, input.applicationRequestId);
  const provider = getScottyProvider();
  if (!provider.cancelJob) {
    throw new AnalysisStatusError(
      501,
      "INVALID_REQUEST",
      "This analysis provider does not support cancellation.",
    );
  }
  try {
    const cancel = await provider.cancelJob({
      externalJobId: record.externalJobId!,
      applicationRequestId: record.applicationRequestId,
      reason: input.reason,
    });
    await getAnalysisSubmissionRepository().update(record.applicationRequestId, {
      lastKnownStatus: "cancelled",
      cancelledAt: cancel.cancelledAt,
      reportReady: false,
      userActionRequired: false,
    });
    logEvent("analysis_cancelled", {
      applicationRequestId: record.applicationRequestId,
      uploadId: record.uploadId,
    });
    return getAnalysisStatus({
      ownerId: input.ownerId,
      applicationRequestId: input.applicationRequestId,
    });
  } catch (err) {
    mapProviderError(err);
  }
}
