import { z } from "zod";
import { SCOTTY_CONTRACT_VERSION } from "./version";

export const scottyErrorCodeSchema = z.enum([
  "INVALID_REQUEST",
  "UNSUPPORTED_CONTRACT_VERSION",
  "UNSUPPORTED_GAME",
  "GAME_NOT_YET_SUPPORTED",
  "INVALID_PLATFORM_CONTROL_COMBINATION",
  "VIDEO_DURATION_EXCEEDED",
  "VIDEO_FILE_TOO_LARGE",
  "UNSUPPORTED_MEDIA_TYPE",
  "MEDIA_INSPECTION_FAILED",
  "UPLOAD_NOT_FOUND",
  "UPLOAD_EXPIRED",
  "MEDIA_ALREADY_DELETED",
  "PROCESSING_LEASE_CONFLICT",
  "PLAYER_IDENTITY_UNCONFIRMED",
  "PLAYER_CONFIRMATION_INVALID",
  "PLAYER_CANDIDATE_EXPIRED",
  "PLAYER_CANDIDATE_NOT_FOUND",
  "PLAYER_FRAME_NOT_FOUND",
  "PLAYER_IDENTIFICATION_ALREADY_RUNNING",
  "PLAYER_IDENTIFICATION_FAILED",
  "FRAME_EXTRACTION_FAILED",
  "UPLOAD_NOT_READY",
  "ANALYSIS_TIMEOUT",
  "ANALYSIS_FAILED",
  "REPORT_VALIDATION_FAILED",
  "PROVIDER_UNAVAILABLE",
  "RATE_LIMITED",
  "UNAUTHORIZED",
  "FORBIDDEN",
  "RETENTION_LIMIT_REACHED",
  "MEDIA_DELETION_FAILED",
]);
export type ScottyErrorCode = z.infer<typeof scottyErrorCodeSchema>;

const SAFE_DETAIL_VALUE = z.union([
  z.string().max(200),
  z.number(),
  z.boolean(),
  z.null(),
]);

export const scottyErrorResponseSchema = z.object({
  contractVersion: z.string().default(SCOTTY_CONTRACT_VERSION),
  code: scottyErrorCodeSchema,
  /** Safe user-facing message — never stack traces or secrets. */
  message: z.string().trim().min(1).max(500),
  retryable: z.boolean(),
  requestId: z.string().trim().min(1).max(128),
  jobId: z.string().trim().min(1).max(128).optional(),
  uploadId: z.string().trim().min(1).max(128).optional(),
  /** Bounded safe details only (no stacks, keys, URLs, or media). */
  details: z.record(SAFE_DETAIL_VALUE).optional(),
});
export type ScottyErrorResponse = z.infer<typeof scottyErrorResponseSchema>;

export function scottyErrorMessage(code: ScottyErrorCode): string {
  const map: Record<ScottyErrorCode, string> = {
    INVALID_REQUEST: "The request was invalid.",
    UNSUPPORTED_CONTRACT_VERSION: "This app version is incompatible with the analysis service.",
    UNSUPPORTED_GAME: "This game is not supported.",
    GAME_NOT_YET_SUPPORTED: "This game has been released but is not supported yet.",
    INVALID_PLATFORM_CONTROL_COMBINATION: "The selected platform and control scheme are not a valid combination.",
    VIDEO_DURATION_EXCEEDED: "Video exceeds the 30-minute maximum duration.",
    VIDEO_FILE_TOO_LARGE: "Video file exceeds the maximum upload size.",
    UNSUPPORTED_MEDIA_TYPE: "Unsupported media type. Upload an MP4 or MOV clip.",
    MEDIA_INSPECTION_FAILED: "We couldn't inspect this video. Try a different file.",
    UPLOAD_NOT_FOUND: "Upload not found.",
    UPLOAD_EXPIRED: "This upload has expired.",
    MEDIA_ALREADY_DELETED: "The source gameplay video has already been deleted.",
    PROCESSING_LEASE_CONFLICT: "This upload is busy with another analysis job.",
    PLAYER_IDENTITY_UNCONFIRMED: "Confirm which player you controlled before continuing.",
    PLAYER_CONFIRMATION_INVALID: "That player confirmation was invalid.",
    PLAYER_CANDIDATE_EXPIRED: "That player candidate has expired.",
    PLAYER_CANDIDATE_NOT_FOUND: "That player candidate was not found.",
    PLAYER_FRAME_NOT_FOUND: "That confirmation frame was not found.",
    PLAYER_IDENTIFICATION_ALREADY_RUNNING: "Player identification is already in progress.",
    PLAYER_IDENTIFICATION_FAILED: "We couldn't identify your controlled player.",
    FRAME_EXTRACTION_FAILED: "We couldn't extract confirmation frames from this video.",
    UPLOAD_NOT_READY: "This upload is not ready for player identification.",
    ANALYSIS_TIMEOUT: "Analysis took too long. Try again in a moment.",
    ANALYSIS_FAILED: "Gameplay analysis failed. Try again.",
    REPORT_VALIDATION_FAILED: "The analysis report could not be validated.",
    PROVIDER_UNAVAILABLE: "The analysis service is temporarily unavailable.",
    RATE_LIMITED: "Too many requests. Wait a moment and try again.",
    UNAUTHORIZED: "You need to sign in to continue.",
    FORBIDDEN: "You don't have access to this resource.",
    RETENTION_LIMIT_REACHED: "Processing exceeded the maximum media retention window.",
    MEDIA_DELETION_FAILED: "Source media could not be deleted safely. We will retry.",
  };
  return map[code];
}
