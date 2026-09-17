/**
 * Public readiness gate — mirrors GET /api/health/readiness (server/src/routes/readiness.ts).
 * The server refuses submissions while analysis is disabled; the Upload screen asks first so
 * the player sees "not open yet" instead of a failed upload.
 */
import { API_BASE_URL } from "./apiBase";

export type AnalysisReadiness = "enabled" | "disabled" | "unknown";

export async function fetchAnalysisReadiness(signal?: AbortSignal): Promise<AnalysisReadiness> {
  try {
    const res = await fetch(`${API_BASE_URL}/api/health/readiness`, { signal, cache: "no-store" });
    const body = (await res.json().catch(() => null)) as { analysisSubmission?: unknown } | null;
    return body?.analysisSubmission === "enabled" ? "enabled" : "disabled";
  } catch {
    // Network failure or abort — the screen shows "can't reach the service", never the demo.
    return "unknown";
  }
}

export const ANALYSIS_CLOSED_MESSAGE =
  "Analysis isn't open yet. Your account and gameplay profile are saved — uploads switch on the moment coaching goes live.";

export const ANALYSIS_UNKNOWN_MESSAGE =
  "We couldn't reach the analysis service. Check your connection and try again.";
