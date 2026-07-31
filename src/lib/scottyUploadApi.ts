/**
 * Scotty Step 2 upload + profile client.
 * Production (supabase_storage): create session → direct TUS → complete.
 * Development (local_disk): create session → streamed PUT → complete.
 * Auth via centralized token helper / authenticatedFetch (Step 10.1B).
 */
import { API_BASE_URL } from "./apiBase";
import { authenticatedFetch } from "./authenticatedFetch";
import {
  ensureOwnerSession,
  getAccessTokenForApi,
  getStoredDevOwnerToken as getStoredOwnerToken,
} from "./authToken";
import {
  uploadGameplayViaSupabaseTus,
  type UploadProgress,
} from "./supabaseGameplayUpload";

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
  transport?: "server_stream" | "supabase_resumable";
  bucket?: string;
  objectPath?: string;
  resumableEndpoint?: string;
  maxBytes: number;
  retentionHours: number;
  retentionNotice: string;
  expiresAt?: string;
  pendingExpiresAt?: string;
  allowedMimeTypes?: string[];
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

export async function markTransferActive(
  _token: string | undefined,
  uploadId: string,
): Promise<void> {
  await authenticatedFetch(`${API_BASE_URL}/api/uploads/${uploadId}/transfer-active`, {
    method: "POST",
  }).catch(() => undefined);
}

export async function completeUpload(
  _token: string | undefined,
  uploadId: string,
): Promise<PublicUploadDetail> {
  const res = await authenticatedFetch(`${API_BASE_URL}/api/uploads/${uploadId}/complete`, {
    method: "POST",
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { message?: string; error?: string };
    throw new Error(err.message || err.error || "Upload completion failed");
  }
  return res.json() as Promise<PublicUploadDetail>;
}

/** XHR streamed PUT with transfer progress (development / local_disk only). */
export function putUploadContent(
  token: string,
  uploadUrl: string,
  file: File,
  onProgress: (pct: number) => void,
  signal?: AbortSignal,
): Promise<PublicUploadDetail> {
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

/**
 * High-level upload: chooses server-stream vs direct Supabase TUS from session.transport.
 */
export async function uploadDirect(
  token: string | undefined,
  session: UploadSessionResponse,
  file: File,
  onProgress: (progress: { percent: number; bytesUploaded: number; bytesTotal: number }) => void,
  signal?: AbortSignal,
): Promise<PublicUploadDetail> {
  if (session.transport === "supabase_resumable") {
    if (!session.bucket || !session.objectPath || !session.resumableEndpoint) {
      throw new Error("Upload session missing Supabase Storage fields.");
    }
    await markTransferActive(token, session.uploadId);
    const heartbeat = window.setInterval(() => {
      void markTransferActive(token, session.uploadId);
    }, 60_000);
    try {
      await uploadGameplayViaSupabaseTus({
        session: {
          uploadId: session.uploadId,
          bucket: session.bucket,
          objectPath: session.objectPath,
          resumableEndpoint: session.resumableEndpoint,
          maxBytes: session.maxBytes,
          allowedMimeTypes: session.allowedMimeTypes,
          expiresAt: session.expiresAt,
        },
        file,
        signal,
        onProgress: (p: UploadProgress) => {
          onProgress({
            percent: p.percent,
            bytesUploaded: p.bytesUploaded,
            bytesTotal: p.bytesTotal,
          });
        },
      });
    } finally {
      window.clearInterval(heartbeat);
    }
    return completeUpload(token, session.uploadId);
  }

  // Development / local_disk streamed path.
  const bearer = token || (await getAccessTokenForApi()) || "";
  return putUploadContent(
    bearer,
    session.uploadUrl,
    file,
    (pct) => onProgress({ percent: pct, bytesUploaded: 0, bytesTotal: file.size }),
    signal,
  );
}

export async function cancelUpload(_token: string | undefined, uploadId: string): Promise<void> {
  await authenticatedFetch(`${API_BASE_URL}/api/uploads/${uploadId}`, {
    method: "DELETE",
  });
}

export async function getUpload(
  _token: string | undefined,
  uploadId: string,
): Promise<PublicUploadDetail> {
  const res = await authenticatedFetch(`${API_BASE_URL}/api/uploads/${uploadId}`);
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { message?: string; error?: string };
    throw new Error(err.message || err.error || "Failed to load upload");
  }
  return res.json() as Promise<PublicUploadDetail>;
}
