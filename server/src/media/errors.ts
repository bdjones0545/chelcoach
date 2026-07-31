/**
 * Internal extraction failure taxonomy → public ErrorCode + user-safe message.
 * Never put raw ffmpeg stderr in client-facing messages.
 */
import type { ErrorCode } from "../contract";

export type InternalMediaErrorCode =
  | "FFMPEG_UNAVAILABLE"
  | "FFPROBE_FAILED"
  | "NO_VIDEO_STREAM"
  | "VIDEO_TOO_LARGE"
  | "VIDEO_TOO_LONG"
  | "INVALID_VIDEO_METADATA"
  | "FRAME_EXTRACTION_FAILED"
  | "PROCESS_TIMEOUT"
  | "PROCESSING_CAPACITY_REACHED"
  | "STORAGE_READ_FAILED"
  | "PROCESSING_INTERNAL_ERROR";

export class MediaProcessingError extends Error {
  readonly internalCode: InternalMediaErrorCode;
  readonly publicCode: ErrorCode;
  readonly userMessage: string;

  constructor(internalCode: InternalMediaErrorCode, detail?: string) {
    const mapped = mapError(internalCode);
    super(detail ? `${internalCode}: ${detail}` : internalCode);
    this.name = "MediaProcessingError";
    this.internalCode = internalCode;
    this.publicCode = mapped.publicCode;
    this.userMessage = mapped.userMessage;
  }
}

function mapError(code: InternalMediaErrorCode): { publicCode: ErrorCode; userMessage: string } {
  switch (code) {
    case "FFMPEG_UNAVAILABLE":
      return {
        publicCode: "ffmpeg_unavailable",
        userMessage: "Video processing isn't available on this server right now. Try again later.",
      };
    case "FFPROBE_FAILED":
    case "NO_VIDEO_STREAM":
    case "INVALID_VIDEO_METADATA":
      return {
        publicCode: "invalid_video",
        userMessage: "That file doesn't look like a readable gameplay video. Re-export as MP4 or MOV and try again.",
      };
    case "VIDEO_TOO_LARGE":
      return {
        publicCode: "video_too_large",
        userMessage: "That clip's resolution is too high for analysis. Re-export at 1080p or lower and try again.",
      };
    case "VIDEO_TOO_LONG":
      return {
        publicCode: "video_too_long",
        userMessage: "That clip is longer than ChelCoach can analyze right now. Trim it to a few minutes and try again.",
      };
    case "FRAME_EXTRACTION_FAILED":
      return {
        publicCode: "extraction_failed",
        userMessage: "We couldn't extract frames from that clip. Re-export the video and try again.",
      };
    case "PROCESS_TIMEOUT":
      return {
        publicCode: "process_timeout",
        userMessage: "Processing timed out on that clip. Try a shorter export and try again.",
      };
    case "PROCESSING_CAPACITY_REACHED":
      return {
        publicCode: "processing_busy",
        userMessage: "ChelCoach is busy processing other clips. Wait a moment and try again.",
      };
    case "STORAGE_READ_FAILED":
      return {
        publicCode: "upload_incomplete",
        userMessage: "We couldn't read the uploaded clip. Upload it again and retry.",
      };
    case "PROCESSING_INTERNAL_ERROR":
    default:
      return {
        publicCode: "extraction_failed",
        userMessage: "Something went wrong while preparing your clip. Try again in a moment.",
      };
  }
}
