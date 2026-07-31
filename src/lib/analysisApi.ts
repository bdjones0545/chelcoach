/**
 * Step 4 analysis submission client — ChelCoach backend only.
 * Never selects provider URL, signing mode, model, or API keys.
 */
import { API_BASE_URL } from "./apiBase";
import { ensureOwnerSession } from "./scottyUploadApi";

export type AnalysisSubmitUiState =
  | "ready_to_submit"
  | "submitting"
  | "accepted"
  | "submission_failed";

export interface AnalysisSubmissionResult {
  applicationRequestId: string;
  uploadId: string;
  provider: string;
  status: string;
  acceptedAt: string;
  reused: boolean;
  nextAction: string;
  pollAfterMs?: number;
  errorCode?: string;
  errorMessage?: string;
}

export async function submitGameplayAnalysis(
  uploadId: string,
): Promise<AnalysisSubmissionResult> {
  const token = await ensureOwnerSession();
  const res = await fetch(`${API_BASE_URL}/api/uploads/${uploadId}/analysis`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "X-ChelCoach-Requested-With": "chelcoach",
    },
    // No provider-specific parameters — server controls capabilities.
    body: JSON.stringify({}),
  });
  const body = (await res.json()) as AnalysisSubmissionResult & {
    message?: string;
    error?: string;
  };
  if (!res.ok) {
    throw new Error(body.message || body.error || "Analysis submission failed");
  }
  // Never surface provider base URLs from responses (none should be present).
  if (JSON.stringify(body).includes("SCOTTY_BASE_URL") || "scottyBaseUrl" in body) {
    throw new Error("Unexpected provider configuration in response");
  }
  return body;
}
