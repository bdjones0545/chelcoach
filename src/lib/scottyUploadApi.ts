/**
 * Scotty Step 2 upload + profile client (streamed PUT with progress).
 * Auth via centralized token helper / authenticatedFetch (Step 10.1B).
 */
import { API_BASE_URL } from "./apiBase";
import { authenticatedFetch } from "./authenticatedFetch";
import {
  ensureOwnerSession,
  getStoredDevOwnerToken as getStoredOwnerToken,
} from "./authToken";

export { ensureOwnerSession, getStoredOwnerToken };

export interface GameplayProfileDto {
  userId: string;
  preferredPlatform: string;
  preferredControlScheme: string;
  primaryPosition: string;
  commonGameMode: string;
  consoleGeneration?: string;
  defaultIndicatorColor?: string | null;
  defaultTeamSide?: string;
  lastSelectedGameId?: string | null;
}

export async function fetchGameplayProfile(_token?: string): Promise<GameplayProfileDto> {
  const res = await authenticatedFetch(`${API_BASE_URL}/api/gameplay-profile`);
  if (!res.ok) throw new Error("Failed to load profile");
  return res.json() as Promise<GameplayProfileDto>;
}

export interface UploadContextPayload {
  gameContext: {
    selectedGameTitle: string;
    canonicalGameId: string;
    supportStatus: string;
    mismatchState: string;
  };
  playerContext: {
    platform: string;
    controlScheme: string;
    position: string;
    gameMode: string;
    jerseyNumber?: number | null;
    indicatorColor?: string | null;
    teamSide?: string;
    consoleGeneration?: string;
  };
  singlePlayerControl: boolean;
}

export interface UploadSessionResponse {
  uploadId: string;
  uploadUrl: string;
  maxBytes: number;
  retentionHours: number;
  retentionNotice: string;
}

export async function createUploadSession(
  _token: string | undefined,
  input: {
    filename: string;
    contentType: string;
    sizeBytes: number;
    context: UploadContextPayload;
    saveAsDefaults: boolean;
  },
): Promise<UploadSessionResponse> {
  const res = await authenticatedFetch(`${API_BASE_URL}/api/uploads`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { message?: string; error?: string };
    throw new Error(err.message || err.error || "Upload session failed");
  }
  return res.json() as Promise<UploadSessionResponse>;
}

export interface PublicUploadDetail {
  uploadId: string;
  uploadStatus: string;
  displayFilename: string;
  byteSize: number;
  durationSec?: number;
  mediaClassification?: string;
  retentionNotice: string;
  errorMessage?: string;
}

/** XHR streamed PUT with transfer progress (actual loaded/total bytes). */
export function putUploadContent(
  token: string,
  uploadUrl: string,
  file: File,
  onProgress: (pct: number) => void,
  signal?: AbortSignal,
): Promise<PublicUploadDetail> {
  // XHR cannot use authenticatedFetch; still only target ChelCoach API origin.
  const target = `${API_BASE_URL}${uploadUrl}`;
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", target);
    xhr.setRequestHeader("authorization", `Bearer ${token}`);
    xhr.setRequestHeader("content-type", file.type || "video/mp4");
    xhr.setRequestHeader("X-ChelCoach-Requested-With", "chelcoach");

    xhr.upload.onprogress = (ev) => {
      if (ev.lengthComputable && ev.total > 0) {
        onProgress(Math.round((ev.loaded / ev.total) * 100));
      }
    };
    xhr.onload = () => {
      try {
        const body = JSON.parse(xhr.responseText) as PublicUploadDetail & {
          message?: string;
          error?: string;
        };
        if (xhr.status >= 200 && xhr.status < 300) resolve(body);
        else reject(new Error(body.message || body.error || "Upload failed"));
      } catch {
        reject(new Error("Upload failed"));
      }
    };
    xhr.onerror = () => reject(new Error("Network error"));
    xhr.onabort = () => reject(new Error("Upload cancelled"));
    signal?.addEventListener("abort", () => xhr.abort());
    xhr.send(file);
  });
}

export async function cancelUpload(_token: string | undefined, uploadId: string): Promise<void> {
  await authenticatedFetch(`${API_BASE_URL}/api/uploads/${uploadId}`, {
    method: "DELETE",
  });
}
