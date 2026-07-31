/**
 * Client-safe development instrumentation for analysis polling (Step 7).
 * Never logs secrets, report bodies, or tokens.
 */

export type AnalysisClientTelemetryEvent =
  | "polling_started"
  | "polling_stopped"
  | "status_advanced"
  | "stale_response_ignored"
  | "network_retry_scheduled"
  | "visibility_pause"
  | "connectivity_pause"
  | "confirmation_required"
  | "cancellation_requested"
  | "report_available"
  | "route_recovery_completed";

type TelemetryPayload = {
  applicationRequestId?: string;
  status?: string;
  statusSequence?: number;
  reason?: string;
  attempt?: number;
  delayMs?: number;
};

const seenUnchangedKeys = new Set<string>();

export function emitAnalysisTelemetry(
  event: AnalysisClientTelemetryEvent,
  payload: TelemetryPayload = {},
): void {
  const mode = typeof import.meta !== "undefined" ? import.meta.env?.MODE : undefined;
  const isTest = mode === "test";
  if (isTest) return; // Keep unit tests quiet; instrumentation is for local/dev.
  const isDev = typeof import.meta !== "undefined" && import.meta.env?.DEV === true;
  if (!isDev && event === "status_advanced" && payload.statusSequence != null) {
    // Production: skip noisy unchanged polls — only log meaningful advances once.
    const key = `${payload.applicationRequestId}:${payload.statusSequence}`;
    if (seenUnchangedKeys.has(key)) return;
    seenUnchangedKeys.add(key);
  }
  if (!isDev && (event === "polling_started" || event === "polling_stopped")) {
    console.debug(`[chelcoach-analysis] event=${event}`, sanitize(payload));
    return;
  }
  if (!isDev) return;
  console.debug(`[chelcoach-analysis] event=${event}`, sanitize(payload));
}

function sanitize(payload: TelemetryPayload): TelemetryPayload {
  return {
    applicationRequestId: payload.applicationRequestId
      ? `${payload.applicationRequestId.slice(0, 8)}…`
      : undefined,
    status: payload.status,
    statusSequence: payload.statusSequence,
    reason: payload.reason,
    attempt: payload.attempt,
    delayMs: payload.delayMs,
  };
}
