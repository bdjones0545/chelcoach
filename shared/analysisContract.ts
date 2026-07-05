/**
 * ChelCoach — Analysis Contract (shared, single source of truth)
 *
 * This is the shape the backend must produce per clip and the shape the frontend
 * already renders. It mirrors `src/data/mockData.ts` as closely as possible so the
 * frontend can later swap the static mock for a fetched `AnalysisReport` with almost
 * no component changes.
 *
 * Phase 0: no runtime is wired yet. This file defines the Zod schemas + inferred
 * types only. Backend validates against these; frontend imports the inferred TYPES
 * (type-only, so `zod` never ends up in the client bundle).
 */
import { z } from "zod";

// --- Primitives --------------------------------------------------------------

/** Semantic performance tone: success (green) / caution (blue) / danger (red). */
export const metricToneSchema = z.enum(["good", "warn", "bad"]);
export type MetricTone = z.infer<typeof metricToneSchema>;

/** Coaching-moment classification used by the Locked Film Preview. */
export const momentTypeSchema = z.enum(["great", "missed", "breakdown"]);
export type MomentType = z.infer<typeof momentTypeSchema>;

// --- Scorecard ---------------------------------------------------------------

export const metricSchema = z.object({
  key: z.string(),
  label: z.string(),
  value: z.number().min(0).max(100),
  /** Material Symbols icon name (see frontend <Icon />). */
  icon: z.string(),
  tone: metricToneSchema,
  note: z.string(),
});
export type Metric = z.infer<typeof metricSchema>;

const titledDetailSchema = z.object({
  title: z.string(),
  detail: z.string(),
});

export const scorecardSchema = z.object({
  chelRating: z.number().int().min(0).max(1000),
  percentile: z.string(), // e.g. "Top 18% of Players"
  overallGrade: z.string(), // e.g. "B-"
  eventsAnalyzed: z.number().int().nonnegative(),
  gameContext: z.string(),
  metrics: z.array(metricSchema).min(1),
  biggestStrength: titledDetailSchema,
  biggestWeakness: titledDetailSchema,
});
export type Scorecard = z.infer<typeof scorecardSchema>;

// --- Coaching moments (Locked Film Preview) ----------------------------------

export const coachingMomentSchema = z.object({
  id: z.string(),
  type: momentTypeSchema,
  label: z.string(), // "Great Play" | "Missed Opportunity" | "Defensive Breakdown"
  timestamp: z.string(), // "4:18"
  period: z.string(), // "P2"
  title: z.string(),
  /** Always returned — shown openly to tease the moment. */
  teaser: z.string(),
  /** The paid payoff — gated behind the paywall in the preview (client-gated for now). */
  fullBreakdown: z.string(),
  /**
   * Signed frame-thumbnail URL. Optional in the contract: the backend fills this once
   * frame extraction exists (Phase 3). When absent, the frontend falls back to a local
   * placeholder asset so the UI never breaks.
   */
  thumbnail: z.string().optional(),
});
export type CoachingMoment = z.infer<typeof coachingMomentSchema>;

// --- Full Film Room ----------------------------------------------------------

export const timelineMarkerSchema = z.object({
  position: z.number().min(0).max(100), // percentage along the track
  tone: metricToneSchema,
  label: z.string(),
  timestamp: z.string(),
});
export type TimelineMarker = z.infer<typeof timelineMarkerSchema>;

export const impactMeterSchema = z.object({
  label: z.string(),
  detail: z.string(),
  value: z.number().min(0).max(100),
  score: z.string(), // e.g. "7.8"
  tone: metricToneSchema,
});
export type ImpactMeter = z.infer<typeof impactMeterSchema>;

export const gameSummaryRowSchema = z.object({
  label: z.string(),
  value: z.string(),
});
export type GameSummaryRow = z.infer<typeof gameSummaryRowSchema>;

export const filmRoomSchema = z.object({
  matchup: z.string(),
  clipLabel: z.string(),
  clipPhase: z.string(),
  /** Signed poster-frame URL (Phase 3). Frontend falls back to a local asset when absent. */
  videoPoster: z.string().optional(),
  markers: z.array(timelineMarkerSchema),
  commentary: z.string(),
  strengths: z.array(z.string()),
  mistakes: z.array(z.string()),
  highestImpactAdjustment: titledDetailSchema,
  nextGameFocus: z.string(),
  weeklySkillFocus: z.array(titledDetailSchema),
  gameSummary: z.array(gameSummaryRowSchema),
  impactMeters: z.array(impactMeterSchema),
});
export type FilmRoom = z.infer<typeof filmRoomSchema>;

// --- The report (what the AI produces and the UI consumes) -------------------

export const analysisReportSchema = z.object({
  scorecard: scorecardSchema,
  coachingMoments: z.array(coachingMomentSchema),
  filmRoom: filmRoomSchema,
});
export type AnalysisReport = z.infer<typeof analysisReportSchema>;

// --- Processing status (clip lifecycle) --------------------------------------

export const clipStatusSchema = z.enum([
  "uploading", // client is uploading to storage
  "queued", // upload committed, waiting for the worker
  "extracting", // frame extraction (Phase 3)
  "analyzing", // AI pass (Phase 4)
  "complete", // report ready
  "failed", // any active step failed
]);
export type ClipStatus = z.infer<typeof clipStatusSchema>;

/** Machine-readable failure reasons, mapped to existing UI state panels. */
export const errorCodeSchema = z.enum([
  "unsupported_file",
  "oversized_file",
  "upload_incomplete",
  "extraction_failed",
  "analysis_failed",
  "invalid_report",
  "rate_limited",
]);
export type ErrorCode = z.infer<typeof errorCodeSchema>;

// --- API request / response envelopes ----------------------------------------

export const uploadInitRequestSchema = z.object({
  filename: z.string().min(1),
  contentType: z.string().min(1),
  sizeBytes: z.number().int().positive(),
});
export type UploadInitRequest = z.infer<typeof uploadInitRequestSchema>;

/** Accepted upload constraints — server-authoritative, shared source of truth. */
export const uploadRules = {
  acceptExtensions: [".mp4", ".mov"],
  acceptMimeTypes: ["video/mp4", "video/quicktime"],
  maxBytes: 2 * 1024 ** 3, // 2 GB
  maxLabel: "2 GB",
} as const;

export interface UploadValidationError {
  code: Extract<ErrorCode, "unsupported_file" | "oversized_file">;
  message: string;
}

/** Validate declared upload metadata against the rules. Returns null when valid. */
export function validateUploadMetadata(input: UploadInitRequest): UploadValidationError | null {
  const name = input.filename.toLowerCase();
  const extOk = uploadRules.acceptExtensions.some((ext) => name.endsWith(ext));
  const mimeOk = (uploadRules.acceptMimeTypes as readonly string[]).includes(input.contentType);
  if (!extOk && !mimeOk) {
    return { code: "unsupported_file", message: "Unsupported file type. Upload an MP4 or MOV clip." };
  }
  if (input.sizeBytes > uploadRules.maxBytes) {
    return { code: "oversized_file", message: `File exceeds the ${uploadRules.maxLabel} limit.` };
  }
  return null;
}

export interface UploadInitResponse {
  clipId: string;
  /** Where the client uploads the file bytes (Phase 2: server-proxied PUT). */
  uploadUrl: string;
}

export interface CommitResponse {
  clipId: string;
  jobId: string;
  status: ClipStatus;
}

export interface ClipStatusResponse {
  clipId: string;
  status: ClipStatus;
  /** Phase-based progress 0–100 for the Processing screen. */
  phaseProgress: number;
  errorCode?: ErrorCode;
  errorMessage?: string;
}

/**
 * Combined clip envelope returned by GET /api/clips/:id — status plus the report
 * once `status === "complete"`. The frontend can poll this single endpoint and read
 * `report` when present.
 */
export interface ClipResponse extends ClipStatusResponse {
  report?: AnalysisReport;
}

export interface AnalysisResponse {
  clipId: string;
  report: AnalysisReport;
}

export interface ApiError {
  error: string;
  message: string;
}
