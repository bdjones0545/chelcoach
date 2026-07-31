/**
 * Maps an internal ClipRecord → public AnalysisJobStatus (shared contract).
 * Keep this as the single projection so a future async worker only has to
 * advance ClipRecord.status; the envelope shape stays stable.
 */
import type { AnalysisJobStatus, ClipStatus, ErrorCode } from "./contract";
import { analysisJobStatusSchema } from "./contract";
import type { ClipRecord } from "./store";

interface JobProjection {
  status: AnalysisJobStatus["status"];
  stage: AnalysisJobStatus["stage"];
  phaseProgress: number;
  reportReady: boolean;
  message: string;
}

function projectClipStatus(status: ClipStatus, hasReport: boolean): JobProjection {
  switch (status) {
    case "uploading":
      return {
        status: "queued",
        stage: "queued",
        phaseProgress: 0,
        reportReady: false,
        message: "Upload in progress.",
      };
    case "queued":
      return {
        status: "queued",
        stage: "queued",
        phaseProgress: 25,
        reportReady: false,
        message: "Queued for analysis.",
      };
    case "extracting":
    case "analyzing":
      // Reserved for future ffmpeg / AI phases — mapped to public "processing".
      return {
        status: "processing",
        stage: "processing",
        phaseProgress: status === "extracting" ? 50 : 75,
        reportReady: false,
        message: "Analyzing your clip.",
      };
    case "complete":
      return {
        status: "completed",
        stage: "ready",
        phaseProgress: 100,
        reportReady: hasReport,
        message: hasReport ? "Report ready." : "Analysis complete.",
      };
    case "failed":
      return {
        status: "failed",
        stage: "failed",
        phaseProgress: 0,
        reportReady: false,
        message: "Analysis failed.",
      };
    default: {
      const _exhaustive: never = status;
      return _exhaustive;
    }
  }
}

/** Build a contract-valid status envelope from a clip record. Throws on drift. */
export function toAnalysisJobStatus(clip: ClipRecord): AnalysisJobStatus {
  const projected = projectClipStatus(clip.status, Boolean(clip.report));
  const errorCode = clip.errorCode as ErrorCode | undefined;

  return analysisJobStatusSchema.parse({
    clipId: clip.id,
    ...(clip.jobId ? { jobId: clip.jobId } : {}),
    status: projected.status,
    message: clip.errorMessage ?? projected.message,
    stage: projected.stage,
    phaseProgress: projected.phaseProgress,
    reportReady: projected.reportReady,
    ...(errorCode ? { errorCode } : {}),
    ...(clip.errorMessage ? { errorMessage: clip.errorMessage } : {}),
    updatedAt: clip.updatedAt,
  });
}
