/**
 * Opaque application request ID validation for durable routes (Step 7).
 * Never put provider job IDs, idempotency keys, or secrets in the URL.
 */

/** UUID or opaque unguessable token — charset-safe for path segments. */
const APPLICATION_REQUEST_ID_RE = /^[A-Za-z0-9_-]{8,128}$/;

export function isValidApplicationRequestId(value: string | undefined | null): value is string {
  if (!value) return false;
  return APPLICATION_REQUEST_ID_RE.test(value);
}

export function parseApplicationRequestIdParam(
  value: string | undefined,
): { ok: true; applicationRequestId: string } | { ok: false } {
  if (!isValidApplicationRequestId(value)) return { ok: false };
  return { ok: true, applicationRequestId: value };
}

export function analysisStatusPath(applicationRequestId: string): string {
  return `/analysis/${encodeURIComponent(applicationRequestId)}`;
}

export function analysisReportPath(applicationRequestId: string): string {
  return `/analysis/${encodeURIComponent(applicationRequestId)}/report`;
}

export function analysisConfirmPath(applicationRequestId: string): string {
  return `/analysis/${encodeURIComponent(applicationRequestId)}/confirm-player`;
}
