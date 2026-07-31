/**
 * Scotty Step 2 upload + profile client (streamed PUT with progress).
 */
import { API_BASE_URL } from "./apiBase";

const TOKEN_KEY = "chelcoach_owner_token";

export function getStoredOwnerToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

function storeOwnerToken(token: string): void {
  try {
    localStorage.setItem(TOKEN_KEY, token);
  } catch {
    /* ignore */
  }
}

export async function ensureOwnerSession(): Promise<string> {
  const existing = getStoredOwnerToken();
  if (existing) {
    const probe = await fetch(`${API_BASE_URL}/api/gameplay-profile`, {
      headers: { authorization: `Bearer ${existing}` },
    });
    if (probe.ok) return existing;
  }
  const res = await fetch(`${API_BASE_URL}/api/session`, { method: "POST" });
  if (!res.ok) throw new Error("Failed to create session");
  const body = (await res.json()) as { token: string };
  storeOwnerToken(body.token);
  return body.token;
}

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

export async function fetchGameplayProfile(token: string): Promise<GameplayProfileDto> {
  const res = await fetch(`${API_BASE_URL}/api/gameplay-profile`, {
    headers: { authorization: `Bearer ${token}` },
  });
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
  token: string,
  input: {
    filename: string;
    contentType: string;
    sizeBytes: number;
    context: UploadContextPayload;
    saveAsDefaults: boolean;
  },
): Promise<UploadSessionResponse> {
  const res = await fetch(`${API_BASE_URL}/api/uploads`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "X-ChelCoach-Requested-With": "chelcoach",
      "content-type": "application/json",
    },
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
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", `${API_BASE_URL}${uploadUrl}`);
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

export async function cancelUpload(token: string, uploadId: string): Promise<void> {
  await fetch(`${API_BASE_URL}/api/uploads/${uploadId}`, {
    method: "DELETE",
    headers: {
      authorization: `Bearer ${token}`,
      "X-ChelCoach-Requested-With": "chelcoach",
    },
  });
}
