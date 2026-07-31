/**
 * Safe structured logging helpers — redact secrets and sensitive payloads.
 */
const REDACT_KEYS =
  /authorization|cookie|password|secret|token|api[_-]?key|signed[_-]?url|storage[_-]?object[_-]?key|database_url|private[_-]?key/i;

export function redactValue(key: string, value: unknown): unknown {
  if (REDACT_KEYS.test(key)) return "[REDACTED]";
  if (typeof value === "string") {
    if (value.startsWith("Bearer ")) return "Bearer [REDACTED]";
    if (/https?:\/\/[^\s]+[?&](X-Amz-|Signature=|token=)/i.test(value)) return "[REDACTED_URL]";
    if (value.length > 500) return `${value.slice(0, 80)}…[truncated ${value.length} chars]`;
  }
  return value;
}

export function safeLogFields(
  fields: Record<string, unknown>,
): Record<string, string | number | boolean | null> {
  const out: Record<string, string | number | boolean | null> = {};
  for (const [k, v] of Object.entries(fields)) {
    const redacted = redactValue(k, v);
    if (
      redacted === null ||
      typeof redacted === "string" ||
      typeof redacted === "number" ||
      typeof redacted === "boolean"
    ) {
      out[k] = redacted;
    } else {
      out[k] = "[complex]";
    }
  }
  return out;
}

export function logSafe(scope: string, event: string, fields: Record<string, unknown> = {}): void {
  const parts = Object.entries(safeLogFields(fields))
    .map(([k, v]) => `${k}=${v}`)
    .join(" ");
  console.log(`[${scope}] event=${event}${parts ? ` ${parts}` : ""}`);
}

/** Sanitize error messages for public JSON responses. */
export function publicErrorMessage(err: unknown, fallback = "Unexpected error."): string {
  if (!(err instanceof Error)) return fallback;
  const msg = err.message;
  if (/ECONNREFUSED|password|secret|postgres|SQL|ENOENT|\/tmp\/|stack/i.test(msg)) {
    return fallback;
  }
  // Allow known stable application codes through as messages only when short/safe.
  if (/^[A-Z][A-Z0-9_]{2,64}$/.test(msg)) return msg;
  if (msg.length <= 120 && !/[<>]/.test(msg)) return msg;
  return fallback;
}
