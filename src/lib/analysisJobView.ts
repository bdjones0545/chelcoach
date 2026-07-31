/**
 * Frontend-safe analysis job view derived from the shared public response (Step 7).
 */
import {
  applicationAnalysisStatusSchema,
  type ApplicationAnalysisStatus,
} from "../../shared/scotty/job";
import type { ScottyJobStatus } from "../../shared/scotty/enums";
import type { ScottyErrorCode } from "../../shared/scotty/errors";
import { AnalysisApiError } from "./analysisClientErrors";
import { getAnalysisStatusPresentation } from "./analysisStatusPresentation";

export type SafeAnalysisError = {
  code?: ScottyErrorCode | string;
  message: string;
  retryable?: boolean;
};

export type AnalysisJobView = {
  applicationRequestId: string;
  uploadId: string;
  status: ScottyJobStatus;
  /** Canonical public sequence — maps from shared `sequenceNumber`. */
  statusSequence: number;
  statusLabel: string;
  statusMessage?: string | null;
  acceptedAt?: string | null;
  updatedAt: string;
  userActionRequired: boolean;
  reportAvailable: boolean;
  cancellationAvailable: boolean;
  terminal: boolean;
  pollAfterMs: number | null;
  degraded: boolean;
  error?: SafeAnalysisError | null;
  /** Dev/test only. */
  simulatorMode?: boolean;
  /** Raw shared status for callers that need the wire shape. */
  raw: ApplicationAnalysisStatus;
};

export function toAnalysisJobView(status: ApplicationAnalysisStatus): AnalysisJobView {
  const presentation = getAnalysisStatusPresentation(status.status);
  const reportAvailable = status.reportAvailable ?? status.reportReady;
  const cancellationAvailable =
    status.cancellationAvailable ??
    (!status.terminal && status.status !== "completed" && !status.userActionRequired);
  const error: SafeAnalysisError | null =
    status.errorMessage || status.errorCode
      ? {
          code: status.errorCode,
          message: status.errorMessage ?? presentation.description,
          retryable: false,
        }
      : null;

  return {
    applicationRequestId: status.applicationRequestId,
    uploadId: status.uploadId,
    status: status.status,
    statusSequence: status.sequenceNumber,
    statusLabel: status.statusLabel || presentation.label,
    statusMessage: status.message ?? null,
    acceptedAt: status.acceptedAt ?? null,
    updatedAt: status.updatedAt,
    userActionRequired: status.userActionRequired,
    reportAvailable,
    cancellationAvailable,
    terminal: status.terminal,
    pollAfterMs: status.pollAfterMs,
    degraded: status.degraded === true,
    error,
    simulatorMode: status.simulatorMode,
    raw: status,
  };
}

export function parseAnalysisStatusResponse(body: unknown): AnalysisJobView {
  const parsed = applicationAnalysisStatusSchema.safeParse(body);
  if (!parsed.success) {
    throw new AnalysisApiError({
      type: "invalid_response",
      retryable: true,
      message: "Received an invalid analysis status response.",
    });
  }
  return toAnalysisJobView(parsed.data);
}

/**
 * Sequence-aware merge for racing / stale client responses.
 * Higher sequence wins. Equal sequence may update safe metadata.
 * Lower sequence must not regress the displayed lifecycle.
 */
export function mergeAnalysisJobView(
  current: AnalysisJobView | null,
  incoming: AnalysisJobView,
): { next: AnalysisJobView; accepted: boolean; reason: "higher" | "equal_meta" | "stale" } {
  if (!current) {
    return { next: incoming, accepted: true, reason: "higher" };
  }
  if (incoming.statusSequence > current.statusSequence) {
    return { next: incoming, accepted: true, reason: "higher" };
  }
  if (incoming.statusSequence < current.statusSequence) {
    return { next: current, accepted: false, reason: "stale" };
  }
  // Equal sequence — update safe metadata only; never regress lifecycle fields.
  const next: AnalysisJobView = {
    ...current,
    updatedAt: incoming.updatedAt || current.updatedAt,
    pollAfterMs: incoming.pollAfterMs,
    degraded: incoming.degraded,
    statusMessage: incoming.statusMessage ?? current.statusMessage,
    statusLabel: incoming.statusLabel || current.statusLabel,
    reportAvailable: current.reportAvailable || incoming.reportAvailable,
    cancellationAvailable: incoming.cancellationAvailable,
    userActionRequired: incoming.userActionRequired,
    error: incoming.error ?? current.error,
    raw: incoming.raw,
  };
  return { next, accepted: true, reason: "equal_meta" };
}

export function shouldPollJob(job: AnalysisJobView): boolean {
  if (job.terminal) return false;
  if (job.userActionRequired) return false;
  if (job.status === "awaiting_player_confirmation") return false;
  if (job.pollAfterMs === null) return false;
  return true;
}
