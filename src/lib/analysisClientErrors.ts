/**
 * Normalized client-observed analysis errors (Step 7).
 * Never expose internal server exception details or provider bodies.
 */

export type AnalysisClientError =
  | { type: "network"; retryable: true; message: string }
  | { type: "offline"; retryable: true; message: string }
  | { type: "session_expired"; retryable: false; message: string }
  | { type: "forbidden"; retryable: false; message: string }
  | { type: "not_found"; retryable: false; message: string }
  | { type: "invalid_response"; retryable: true; message: string }
  | { type: "malformed_id"; retryable: false; message: string }
  | { type: "server"; retryable: boolean; code?: string; message: string };

export class AnalysisApiError extends Error {
  readonly clientError: AnalysisClientError;
  readonly httpStatus?: number;

  constructor(clientError: AnalysisClientError, httpStatus?: number) {
    super(clientError.message);
    this.name = "AnalysisApiError";
    this.clientError = clientError;
    this.httpStatus = httpStatus;
  }
}

const SAFE_ACCESS_MESSAGE = "We could not access this analysis.";
const SAFE_SESSION_MESSAGE = "Your session expired. Sign in again to continue this analysis.";
const SAFE_NETWORK_MESSAGE = "Connection interrupted. Your analysis is still saved.";
const SAFE_OFFLINE_MESSAGE = "You appear to be offline. Your analysis is still saved.";

export function isAnalysisApiError(err: unknown): err is AnalysisApiError {
  return err instanceof AnalysisApiError;
}

export function normalizeAnalysisHttpError(
  status: number,
  body: { error?: string; message?: string; retryable?: boolean } | null,
  _online = true,
): AnalysisApiError {
  if (status === 401) {
    return new AnalysisApiError(
      { type: "session_expired", retryable: false, message: SAFE_SESSION_MESSAGE },
      status,
    );
  }
  if (status === 403 || status === 404) {
    // Do not reveal whether another user owns the job.
    return new AnalysisApiError(
      { type: "forbidden", retryable: false, message: SAFE_ACCESS_MESSAGE },
      status,
    );
  }
  if (status === 502 || status === 503 || status === 504) {
    return new AnalysisApiError(
      {
        type: "server",
        retryable: true,
        code: body?.error,
        message: SAFE_NETWORK_MESSAGE,
      },
      status,
    );
  }
  const retryable = body?.retryable === true;
  const code = typeof body?.error === "string" ? body.error : undefined;
  const message =
    typeof body?.message === "string" && body.message.length > 0 && body.message.length <= 300
      ? body.message
      : "Something went wrong loading this analysis.";
  return new AnalysisApiError(
    { type: "server", retryable, code, message },
    status,
  );
}

export function normalizeTransportError(err: unknown, online = true): AnalysisApiError {
  if (isAnalysisApiError(err)) return err;
  if (err instanceof DOMException && err.name === "AbortError") {
    return new AnalysisApiError({
      type: "network",
      retryable: true,
      message: SAFE_NETWORK_MESSAGE,
    });
  }
  if (err instanceof Error && err.name === "AbortError") {
    return new AnalysisApiError({
      type: "network",
      retryable: true,
      message: SAFE_NETWORK_MESSAGE,
    });
  }
  if (!online) {
    return new AnalysisApiError({
      type: "offline",
      retryable: true,
      message: SAFE_OFFLINE_MESSAGE,
    });
  }
  return new AnalysisApiError({
    type: "network",
    retryable: true,
    message: SAFE_NETWORK_MESSAGE,
  });
}

export function clientErrorUserMessage(err: AnalysisClientError): string {
  return err.message;
}
