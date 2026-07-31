/**
 * Safe report interaction telemetry (Step 8).
 * Never transmits report body, coaching text, identity, video, or private URLs.
 */

export type ReportTelemetryEvent =
  | "report_loaded"
  | "report_section_viewed"
  | "evidence_timestamp_selected"
  | "priority_expanded"
  | "drill_state_changed"
  | "report_load_failed"
  | "video_unavailable";

type Payload = {
  applicationRequestId?: string;
  sectionId?: string;
  timestampSec?: number;
  drillId?: string;
  state?: string;
  reason?: string;
};

export function emitReportTelemetry(event: ReportTelemetryEvent, payload: Payload = {}): void {
  if (typeof import.meta !== "undefined" && import.meta.env?.MODE === "test") return;
  const isDev = typeof import.meta !== "undefined" && import.meta.env?.DEV === true;
  if (!isDev && event === "report_section_viewed") return;
  console.debug(`[chelcoach-report] event=${event}`, {
    applicationRequestId: payload.applicationRequestId
      ? `${payload.applicationRequestId.slice(0, 8)}…`
      : undefined,
    sectionId: payload.sectionId,
    timestampSec: payload.timestampSec,
    drillId: payload.drillId,
    state: payload.state,
    reason: payload.reason,
  });
}
