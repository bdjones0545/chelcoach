/**
 * Step 3 controlled-player identification / confirmation client.
 */
import { API_BASE_URL } from "./reportApi";
import { ensureOwnerSession } from "./scottyUploadApi";

export interface PublicConfirmationFrame {
  frameId: string;
  uploadId: string;
  timestampSec: number;
  mimeType: string;
  width: number;
  height: number;
  byteSize: number;
  accessUrl: string;
  expiresAt: string;
}

export interface PublicPlayerCandidate {
  candidateId: string;
  uploadId: string;
  representativeFrameId: string;
  timestampSec: number;
  boundingBox: { x: number; y: number; width: number; height: number };
  position?: string;
  jerseyNumber?: number | null;
  indicatorColor?: string | null;
  teamSide?: string;
  confidence: number;
  evidenceSummary: string;
  thumbnailUrl: string;
  displayLabel: string;
  expiresAt: string;
}

export interface PublicPlayerIdentification {
  identificationId: string;
  uploadId: string;
  status: string;
  detected: boolean;
  confidence: number;
  confidenceLabel: string;
  player?: {
    position: string;
    jerseyNumber: number | null;
    indicatorColor: string | null;
    teamSide: string;
  };
  uncertainties: string[];
  userConfirmed: boolean;
  confirmationId?: string;
  frames: PublicConfirmationFrame[];
  candidates: PublicPlayerCandidate[];
  additionalExtractionAvailable: boolean;
  sourceExpiresAt: string;
  retentionNotice: string;
  errorCode?: string;
  errorMessage?: string;
}

async function authHeaders(): Promise<HeadersInit> {
  const token = await ensureOwnerSession();
  return {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    "X-ChelCoach-Requested-With": "chelcoach",
  };
}

export async function startPlayerIdentification(
  uploadId: string,
  fixtureScenario?: string,
): Promise<PublicPlayerIdentification> {
  const res = await fetch(`${API_BASE_URL}/api/uploads/${uploadId}/player-identification`, {
    method: "POST",
    headers: await authHeaders(),
    body: JSON.stringify(fixtureScenario ? { fixtureScenario } : {}),
  });
  const body = (await res.json()) as PublicPlayerIdentification & { message?: string; error?: string };
  if (!res.ok) throw new Error(body.message || body.error || "Identification failed");
  return body;
}

export async function getPlayerIdentification(uploadId: string): Promise<PublicPlayerIdentification> {
  const token = await ensureOwnerSession();
  const res = await fetch(`${API_BASE_URL}/api/uploads/${uploadId}/player-identification`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const body = (await res.json()) as PublicPlayerIdentification & { message?: string; error?: string };
  if (!res.ok) throw new Error(body.message || body.error || "Failed to load identification");
  return body;
}

export async function confirmPlayer(
  uploadId: string,
  input: {
    selectedCandidateId: string;
    frameId: string;
    confirmedPosition?: string;
    confirmedJerseyNumber?: number;
    confirmedIndicatorColor?: string;
  },
): Promise<PublicPlayerIdentification> {
  const res = await fetch(`${API_BASE_URL}/api/uploads/${uploadId}/player-confirmation`, {
    method: "POST",
    headers: await authHeaders(),
    body: JSON.stringify({
      uploadId,
      selectedCandidateId: input.selectedCandidateId,
      representativeFrame: { frameId: input.frameId, uploadId },
      confirmedPosition: input.confirmedPosition,
      confirmedJerseyNumber: input.confirmedJerseyNumber,
      confirmedIndicatorColor: input.confirmedIndicatorColor,
      confirmedAt: new Date().toISOString(),
    }),
  });
  const body = (await res.json()) as PublicPlayerIdentification & { message?: string; error?: string };
  if (!res.ok) throw new Error(body.message || body.error || "Confirmation failed");
  return body;
}

export async function correctIdentification(uploadId: string): Promise<PublicPlayerIdentification> {
  const res = await fetch(`${API_BASE_URL}/api/uploads/${uploadId}/player-confirmation/correct`, {
    method: "POST",
    headers: await authHeaders(),
    body: JSON.stringify({ reason: "not_my_player" }),
  });
  const body = (await res.json()) as PublicPlayerIdentification & { message?: string; error?: string };
  if (!res.ok) throw new Error(body.message || body.error || "Correction failed");
  return body;
}

export async function noneOfTheAbove(
  uploadId: string,
  input: {
    requestAdditionalExtraction?: boolean;
    hints?: {
      jerseyNumber?: number;
      indicatorColor?: string;
      position?: string;
      teamSide?: string;
    };
  },
): Promise<PublicPlayerIdentification> {
  const res = await fetch(
    `${API_BASE_URL}/api/uploads/${uploadId}/player-confirmation/none-of-the-above`,
    {
      method: "POST",
      headers: await authHeaders(),
      body: JSON.stringify({
        uploadId,
        requestAdditionalExtraction: input.requestAdditionalExtraction ?? false,
        hints: input.hints,
      }),
    },
  );
  const body = (await res.json()) as PublicPlayerIdentification & { message?: string; error?: string };
  if (!res.ok) throw new Error(body.message || body.error || "Request failed");
  return body;
}

/** Authenticated blob URL for a confirmation frame (revoke when done). */
export async function loadFrameObjectUrl(accessUrl: string): Promise<string> {
  const token = await ensureOwnerSession();
  const res = await fetch(`${API_BASE_URL}${accessUrl}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error("Failed to load frame");
  const blob = await res.blob();
  return URL.createObjectURL(blob);
}

const UPLOAD_ID_KEY = "chelcoach_ready_upload_id";

export function storeReadyUploadId(uploadId: string): void {
  try {
    sessionStorage.setItem(UPLOAD_ID_KEY, uploadId);
  } catch {
    /* ignore */
  }
}

export function readReadyUploadId(): string | null {
  try {
    return sessionStorage.getItem(UPLOAD_ID_KEY);
  } catch {
    return null;
  }
}
