/**
 * AI-analysis errors with stable public ErrorCode mapping.
 * Never attach raw provider bodies, prompts, or image data.
 */
import type { ErrorCode } from "../contract";

export type AiInternalCode =
  | "AI_NOT_CONFIGURED"
  | "AI_AUTHENTICATION_FAILED"
  | "AI_REQUEST_TIMEOUT"
  | "AI_RATE_LIMITED"
  | "AI_PROVIDER_UNAVAILABLE"
  | "AI_RESPONSE_INVALID"
  | "AI_RESPONSE_REFUSED"
  | "AI_CONTENT_UNSUPPORTED"
  | "AI_REQUEST_TOO_LARGE"
  | "ANALYSIS_INTERNAL_ERROR"
  | "AI_FRAME_UNREADABLE"
  | "AI_ABORTED";

const PUBLIC: Record<AiInternalCode, ErrorCode> = {
  AI_NOT_CONFIGURED: "ai_not_configured",
  AI_AUTHENTICATION_FAILED: "ai_authentication_failed",
  AI_REQUEST_TIMEOUT: "ai_request_timeout",
  AI_RATE_LIMITED: "ai_rate_limited",
  AI_PROVIDER_UNAVAILABLE: "ai_provider_unavailable",
  AI_RESPONSE_INVALID: "ai_response_invalid",
  AI_RESPONSE_REFUSED: "ai_response_refused",
  AI_CONTENT_UNSUPPORTED: "ai_content_unsupported",
  AI_REQUEST_TOO_LARGE: "ai_request_too_large",
  ANALYSIS_INTERNAL_ERROR: "analysis_internal_error",
  AI_FRAME_UNREADABLE: "analysis_internal_error",
  AI_ABORTED: "analysis_failed",
};

const USER_MESSAGE: Record<AiInternalCode, string> = {
  AI_NOT_CONFIGURED: "Gameplay analysis is not configured on this server. Try again later.",
  AI_AUTHENTICATION_FAILED: "Gameplay analysis is temporarily unavailable. Try again later.",
  AI_REQUEST_TIMEOUT: "Analysis took too long. Try a shorter clip or try again in a moment.",
  AI_RATE_LIMITED: "ChelCoach is busy analyzing other clips. Wait a moment and try again.",
  AI_PROVIDER_UNAVAILABLE: "Gameplay analysis is temporarily unavailable. Try again in a moment.",
  AI_RESPONSE_INVALID: "We couldn't produce a valid analysis for this clip. Try again.",
  AI_RESPONSE_REFUSED: "This clip couldn't be analyzed. Try a different gameplay clip.",
  AI_CONTENT_UNSUPPORTED: "This clip couldn't be analyzed. Try a clearer NHL gameplay recording.",
  AI_REQUEST_TOO_LARGE: "This clip produced too much analysis data. Try a shorter clip.",
  ANALYSIS_INTERNAL_ERROR: "Something went wrong while analyzing your clip. Try again in a moment.",
  AI_FRAME_UNREADABLE: "Something went wrong while preparing frames for analysis. Try again.",
  AI_ABORTED: "Analysis was cancelled.",
};

export class AiAnalysisError extends Error {
  readonly publicCode: ErrorCode;
  readonly userMessage: string;
  /** True when a bounded retry is safe (transient provider issues). */
  readonly retryable: boolean;

  constructor(
    public readonly internalCode: AiInternalCode,
    detail?: string,
    opts?: { retryable?: boolean },
  ) {
    super(detail ?? internalCode);
    this.name = "AiAnalysisError";
    this.publicCode = PUBLIC[internalCode];
    this.userMessage = USER_MESSAGE[internalCode];
    this.retryable = opts?.retryable ?? isRetryableByDefault(internalCode);
  }
}

function isRetryableByDefault(code: AiInternalCode): boolean {
  return (
    code === "AI_REQUEST_TIMEOUT" ||
    code === "AI_RATE_LIMITED" ||
    code === "AI_PROVIDER_UNAVAILABLE"
  );
}

/** Map unknown thrown values into AiAnalysisError without leaking internals. */
export function toAiAnalysisError(err: unknown): AiAnalysisError {
  if (err instanceof AiAnalysisError) return err;
  if (err instanceof Error && err.name === "AbortError") {
    return new AiAnalysisError("AI_ABORTED", err.message, { retryable: false });
  }
  return new AiAnalysisError(
    "ANALYSIS_INTERNAL_ERROR",
    err instanceof Error ? err.message : "unknown",
    { retryable: false },
  );
}
