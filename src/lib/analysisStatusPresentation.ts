/**
 * Centralized canonical status → display label / description (Step 7).
 * Backend-safe messages take precedence when supplied.
 * No provider-specific status strings.
 */
import type { ScottyJobStatus } from "../../shared/scotty/enums";

export type AnalysisStatusPresentation = {
  label: string;
  description: string;
};

export const ANALYSIS_STATUS_PRESENTATION = {
  queued: {
    label: "Queued",
    description: "Your gameplay analysis has been accepted.",
  },
  inspecting_input: {
    label: "Inspecting gameplay",
    description: "Scotty is checking the uploaded video and gameplay context.",
  },
  extracting_frames: {
    label: "Preparing gameplay moments",
    description: "Key gameplay moments are being prepared for analysis.",
  },
  identifying_controlled_player: {
    label: "Tracking your player",
    description: "Scotty is validating which skater you control.",
  },
  awaiting_player_confirmation: {
    label: "Player confirmation needed",
    description: "Select your controlled skater to continue.",
  },
  validating_player_identity: {
    label: "Validating player tracking",
    description: "Your confirmed player is being matched through the video.",
  },
  analyzing_gameplay: {
    label: "Analyzing gameplay",
    description: "Scotty is evaluating decisions, positioning, strategies, and controls.",
  },
  validating_report: {
    label: "Validating coaching report",
    description: "The analysis is being checked for consistency.",
  },
  finalizing: {
    label: "Finalizing report",
    description: "Your coaching report is being prepared.",
  },
  completed: {
    label: "Complete",
    description: "Your coaching report is ready.",
  },
  failed: {
    label: "Analysis failed",
    description: "The analysis could not be completed.",
  },
  cancelled: {
    label: "Cancelled",
    description: "This analysis was cancelled.",
  },
} as const satisfies Record<ScottyJobStatus, AnalysisStatusPresentation>;

export function getAnalysisStatusPresentation(status: ScottyJobStatus): AnalysisStatusPresentation {
  return ANALYSIS_STATUS_PRESENTATION[status];
}

/** Human label helper — kept for Step 5 server test compatibility. */
export function statusLabel(status: string): string {
  if (status in ANALYSIS_STATUS_PRESENTATION) {
    return ANALYSIS_STATUS_PRESENTATION[status as ScottyJobStatus].label;
  }
  return status;
}

/**
 * Stage-based indicator (no percentages).
 * Stages: Upload → Player → Analyze → Report
 */
export type AnalysisStageId = "upload" | "player" | "analyze" | "report";

export type AnalysisStageState = "complete" | "current" | "upcoming" | "failed" | "cancelled";

export type AnalysisStage = {
  id: AnalysisStageId;
  label: string;
  state: AnalysisStageState;
};

const PLAYER_STATUSES: ReadonlySet<ScottyJobStatus> = new Set([
  "identifying_controlled_player",
  "awaiting_player_confirmation",
  "validating_player_identity",
]);

const ANALYZE_STATUSES: ReadonlySet<ScottyJobStatus> = new Set([
  "queued",
  "inspecting_input",
  "extracting_frames",
  "analyzing_gameplay",
  "validating_report",
  "finalizing",
]);

export function analysisStagesForStatus(status: ScottyJobStatus): AnalysisStage[] {
  if (status === "failed") {
    return [
      { id: "upload", label: "Upload", state: "complete" },
      { id: "player", label: "Player", state: "failed" },
      { id: "analyze", label: "Analyze", state: "upcoming" },
      { id: "report", label: "Report", state: "upcoming" },
    ];
  }
  if (status === "cancelled") {
    return [
      { id: "upload", label: "Upload", state: "complete" },
      { id: "player", label: "Player", state: "cancelled" },
      { id: "analyze", label: "Analyze", state: "upcoming" },
      { id: "report", label: "Report", state: "upcoming" },
    ];
  }
  if (status === "completed") {
    return [
      { id: "upload", label: "Upload", state: "complete" },
      { id: "player", label: "Player", state: "complete" },
      { id: "analyze", label: "Analyze", state: "complete" },
      { id: "report", label: "Report", state: "complete" },
    ];
  }

  const onPlayer = PLAYER_STATUSES.has(status);
  const onAnalyze =
    ANALYZE_STATUSES.has(status) &&
    status !== "queued" &&
    !PLAYER_STATUSES.has(status);
  // queued / inspecting / extracting are pre-player analyze prep
  const earlyAnalyze =
    status === "queued" || status === "inspecting_input" || status === "extracting_frames";

  return [
    { id: "upload", label: "Upload", state: "complete" },
    {
      id: "player",
      label: "Player",
      state: onPlayer ? "current" : earlyAnalyze ? "upcoming" : "complete",
    },
    {
      id: "analyze",
      label: "Analyze",
      state: onPlayer
        ? "upcoming"
        : earlyAnalyze || onAnalyze
          ? "current"
          : "upcoming",
    },
    { id: "report", label: "Report", state: "upcoming" },
  ];
}

/** Reject provider-specific leak strings in presentation maps. */
export function presentationContainsProviderLeak(text: string): boolean {
  return /scotty[_-]?vm|anthropic|openai|external[_-]?job|idempotency|hmac|bearer\s/i.test(
    text,
  );
}
