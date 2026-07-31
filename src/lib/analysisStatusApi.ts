/**
 * Step 5 analysis status client — ChelCoach backend only.
 */
import { API_BASE_URL } from "./reportApi";
import { ensureOwnerSession } from "./scottyUploadApi";
import type { AnalysisStatusSnapshot } from "./analysisStatusPoller";

export interface ApplicationAnalysisStatus extends AnalysisStatusSnapshot {
  applicationRequestId: string;
  uploadId: string;
  provider: string;
  sequenceNumber: number;
  acceptedAt?: string;
  updatedAt: string;
}

async function authHeaders(): Promise<HeadersInit> {
  const token = await ensureOwnerSession();
  return { authorization: `Bearer ${token}`, "content-type": "application/json" };
}

export async function fetchAnalysisStatus(
  applicationRequestId: string,
  signal?: AbortSignal,
): Promise<ApplicationAnalysisStatus> {
  const res = await fetch(`${API_BASE_URL}/api/analysis/${applicationRequestId}`, {
    headers: await authHeaders(),
    signal,
  });
  const body = (await res.json()) as ApplicationAnalysisStatus & {
    message?: string;
    error?: string;
  };
  if (!res.ok) {
    throw new Error(body.message || body.error || "Failed to load analysis status");
  }
  return body;
}

export async function fetchAnalysisReport(applicationRequestId: string): Promise<unknown> {
  const res = await fetch(`${API_BASE_URL}/api/analysis/${applicationRequestId}/report`, {
    headers: await authHeaders(),
  });
  const body = (await res.json()) as { message?: string; error?: string };
  if (!res.ok) {
    throw new Error(body.message || body.error || "Report not ready");
  }
  return body;
}

export async function cancelAnalysisRequest(
  applicationRequestId: string,
  reason?: string,
): Promise<ApplicationAnalysisStatus> {
  const res = await fetch(`${API_BASE_URL}/api/analysis/${applicationRequestId}/cancel`, {
    method: "POST",
    headers: await authHeaders(),
    body: JSON.stringify(reason ? { reason } : {}),
  });
  const body = (await res.json()) as ApplicationAnalysisStatus & {
    message?: string;
    error?: string;
  };
  if (!res.ok) {
    throw new Error(body.message || body.error || "Cancel failed");
  }
  return body;
}

export async function confirmRemoteAnalysisPlayer(
  applicationRequestId: string,
  selectedCandidateId: string,
): Promise<ApplicationAnalysisStatus> {
  const res = await fetch(
    `${API_BASE_URL}/api/analysis/${applicationRequestId}/player-confirmation`,
    {
      method: "POST",
      headers: await authHeaders(),
      body: JSON.stringify({ selectedCandidateId }),
    },
  );
  const body = (await res.json()) as ApplicationAnalysisStatus & {
    message?: string;
    error?: string;
  };
  if (!res.ok) {
    throw new Error(body.message || body.error || "Confirmation failed");
  }
  return body;
}
