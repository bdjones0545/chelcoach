/**
 * Maps an internal ClipRecord → public AnalysisJobStatus (shared contract).
 */
import type { AnalysisJobStatus, AnalysisJobStage, ErrorCode } from "./contract";
import { analysisJobStatusSchema } from "./contract";
import type { ClipRecord } from "./store";

interface JobProjection {
  status: AnalysisJobStatus["status"];
  stage: AnalysisJobStage;
  phaseProgress: number;
  reportReady: boolean;
  message: string;
}

function projectClip(clip: ClipRecord): JobProjection {
  const status = clip.status;

  switch (status) {
    case "uploading":
      return {
        status: "queued",
        stage: "queued",
        phaseProgress: clip.phaseProgress ?? 0,
        reportReady: false,
        message: "Upload in progress.",
      };
    case "queued":
      return {
        status: "queued",
        stage: "queued",
        phaseProgress: clip.phaseProgress ?? 15,
        reportReady: false,
        message: "Queued for analysis.",
      };
    case "extracting": {
      const stage: AnalysisJobStage = clip.stage ?? "inspecting_video";
      const messages: Partial<Record<AnalysisJobStage, string>> = {
        inspecting_video: "Inspecting your video…",
        extracting_frames: "Extracting frames…",
        finalizing: "Finalizing…",
      };
      return {
        status: "processing",
        stage,
        phaseProgress: clip.phaseProgress ?? 40,
        reportReady: false,
        message: messages[stage] ?? "Processing your clip…",
      };
    }
    case "analyzing":
      // Reserved for Phase 4 AI — not produced yet.
      return {
        status: "processing",
        stage: "finalizing",
        phaseProgress: clip.phaseProgress ?? 80,
        reportReady: false,
        message: "Analyzing your clip…",
      };
    case "complete":
      return {
        status: "completed",
        stage: "ready",
        phaseProgress: 100,
        reportReady: Boolean(clip.report),
        message: clip.report ? "Report ready." : "Analysis complete.",
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
  const projected = projectClip(clip);
  const errorCode = clip.errorCode as ErrorCode | undefined;

  return analysisJobStatusSchema.parse({
    clipId: clip.id,
    ...(clip.jobId ? { jobId: clip.jobId } : {}),
    status: projected.status,
    message: clip.status === "failed" ? (clip.errorMessage ?? projected.message) : projected.message,
    stage: projected.stage,
    phaseProgress: projected.phaseProgress,
    reportReady: projected.reportReady,
    ...(errorCode ? { errorCode } : {}),
    ...(clip.status === "failed" && clip.errorMessage ? { errorMessage: clip.errorMessage } : {}),
    updatedAt: clip.updatedAt,
  });
}
