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

/**
 * Machine-readable failure reasons returned to the client.
 * Internal FFmpeg/process codes map into this set before leaving the server.
 */
export const errorCodeSchema = z.enum([
  "unsupported_file",
  "oversized_file",
  "upload_incomplete",
  "extraction_failed",
  "analysis_failed",
  "invalid_report",
  "rate_limited",
  "ffmpeg_unavailable",
  "invalid_video",
  "video_too_long",
  "video_too_large",
  "processing_busy",
  "process_timeout",
  // AI analysis (Phase 4) — snake_case to match existing public codes
  "ai_not_configured",
  "ai_authentication_failed",
  "ai_request_timeout",
  "ai_rate_limited",
  "ai_provider_unavailable",
  "ai_response_invalid",
  "ai_response_refused",
  "ai_content_unsupported",
  "ai_request_too_large",
  "analysis_internal_error",
]);
export type ErrorCode = z.infer<typeof errorCodeSchema>;

// --- API request / response envelopes ----------------------------------------

export const uploadInitRequestSchema = z.object({
  filename: z.string().min(1),
  contentType: z.string().min(1),
  sizeBytes: z.number().int().positive(),
});
export type UploadInitRequest = z.infer<typeof uploadInitRequestSchema>;

/**
 * Accepted upload constraints — server-authoritative, shared source of truth.
 *
 * Cap lowered from 2 GB → 250 MB for Phase 3: the upload path still buffers the
 * whole body in Node RAM, and FFmpeg extraction runs in-process. 250 MB keeps
 * gameplay clips workable while bounding memory risk. Revisit when streaming
 * uploads / out-of-process workers land.
 */
export const uploadRules = {
  acceptExtensions: [".mp4", ".mov"],
  acceptMimeTypes: ["video/mp4", "video/quicktime"],
  maxBytes: 250 * 1024 ** 2, // 250 MB
  maxLabel: "250 MB",
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

// --- Analysis-job status (Processing-screen / polling contract) ---------------
//
// Public lifecycle for a committed clip's analysis. Distinct from `clipStatus`
// (upload plumbing: uploading → queued → extracting → analyzing → complete).
// This projection is what the Processing screen polls. Compatible with a future
// async worker: today commit completes immediately → `completed`; later commit
// can leave the job `queued` / `processing` without changing this envelope.

/** Public analysis-job statuses consumed by the Processing screen. */
export const analysisJobStatusValueSchema = z.enum([
  "queued",
  "processing",
  "completed",
  "failed",
]);
export type AnalysisJobStatusValue = z.infer<typeof analysisJobStatusValueSchema>;

/**
 * Coarse stage labels the server may report. Only claim work the backend
 * actually performs (Phase 4: inspect → extract → AI analyze → validate).
 */
export const analysisJobStageSchema = z.enum([
  "queued",
  "inspecting_video",
  "extracting_frames",
  "analyzing_gameplay",
  "validating_report",
  "finalizing",
  "ready",
  "failed",
]);
export type AnalysisJobStage = z.infer<typeof analysisJobStageSchema>;

/**
 * Clip / job identifiers accepted by status routes.
 * Allows UUIDs and the deterministic demo id (`static-demo-clip`); rejects
 * empty strings and characters that don't belong in an id.
 */
export const clipIdParamSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/, "Malformed clip id.");
export type ClipIdParam = z.infer<typeof clipIdParamSchema>;

export const analysisJobStatusSchema = z.object({
  clipId: z.string().min(1),
  jobId: z.string().min(1).optional(),
  status: analysisJobStatusValueSchema,
  /** Safe, user-facing status line (never internal/stack/provider details). */
  message: z.string().optional(),
  stage: analysisJobStageSchema.optional(),
  /** Phase-based progress 0–100 for the Processing screen. */
  phaseProgress: z.number().min(0).max(100).optional(),
  /** True when GET /api/clips/:id/analysis (or the clip envelope) can return the report. */
  reportReady: z.boolean(),
  errorCode: errorCodeSchema.optional(),
  /** Safe failure explanation for the UI. */
  errorMessage: z.string().optional(),
  updatedAt: z.string().optional(),
});
export type AnalysisJobStatus = z.infer<typeof analysisJobStatusSchema>;
