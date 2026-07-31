/**
 * Structural parse of the shared AnalysisJobStatus envelope.
 *
 * Keeps Zod out of the client bundle (type-only import from shared). The server
 * validates with the Zod schema before responding; this guard rejects malformed
 * payloads so live mode never treats garbage / demo data as a real result.
 */
import type { AnalysisJobStatus, AnalysisJobStatusValue } from "../../shared/analysisContract";

const STATUS_VALUES = new Set<AnalysisJobStatusValue>(["queued", "processing", "completed", "failed"]);
const STAGE_VALUES = new Set(["queued", "processing", "finalizing", "ready", "failed"]);

export class InvalidAnalysisJobStatusError extends Error {
  constructor(message = "Malformed analysis status response.") {
    super(message);
    this.name = "InvalidAnalysisJobStatusError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Parse + validate an unknown JSON body into AnalysisJobStatus. Throws on malformation. */
export function parseAnalysisJobStatus(data: unknown): AnalysisJobStatus {
  if (!isRecord(data)) throw new InvalidAnalysisJobStatusError();

  const { clipId, status, reportReady } = data;
  if (typeof clipId !== "string" || clipId.length === 0) {
    throw new InvalidAnalysisJobStatusError("Missing clipId.");
  }
  if (typeof status !== "string" || !STATUS_VALUES.has(status as AnalysisJobStatusValue)) {
    throw new InvalidAnalysisJobStatusError("Invalid status.");
  }
  if (typeof reportReady !== "boolean") {
    throw new InvalidAnalysisJobStatusError("Missing reportReady.");
  }

  const result: AnalysisJobStatus = {
    clipId,
    status: status as AnalysisJobStatusValue,
    reportReady,
  };

  if (typeof data.jobId === "string" && data.jobId.length > 0) result.jobId = data.jobId;
  if (typeof data.message === "string") result.message = data.message;
  if (typeof data.stage === "string" && STAGE_VALUES.has(data.stage)) {
    result.stage = data.stage as AnalysisJobStatus["stage"];
  }
  if (typeof data.phaseProgress === "number" && data.phaseProgress >= 0 && data.phaseProgress <= 100) {
    result.phaseProgress = data.phaseProgress;
  }
  if (typeof data.errorCode === "string") {
    result.errorCode = data.errorCode as AnalysisJobStatus["errorCode"];
  }
  if (typeof data.errorMessage === "string") result.errorMessage = data.errorMessage;
  if (typeof data.updatedAt === "string") result.updatedAt = data.updatedAt;

  // Contract invariant: completed implies the report is available.
  if (result.status === "completed" && !result.reportReady) {
    throw new InvalidAnalysisJobStatusError("completed status without reportReady.");
  }

  return result;
}
