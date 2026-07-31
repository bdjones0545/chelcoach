/**
 * Direct resumable gameplay upload to private Supabase Storage (TUS).
 * Browser → Supabase only; bytes never pass through ChelCoach API.
 *
 * Dependency: tus-js-client — required because Supabase resumable uploads
 * use the TUS protocol; @supabase/supabase-js does not provide a full
 * resumable progress/cancel/resume client for large gameplay files.
 */
import * as tus from "tus-js-client";
import { getSupabaseBrowserClient, readSupabaseBrowserConfig } from "./supabaseClient";

export type SupabaseGameplayUploadSession = {
  uploadId: string;
  bucket: string;
  objectPath: string;
  resumableEndpoint: string;
  maxBytes: number;
  allowedMimeTypes?: string[];
  expiresAt?: string;
};

export type UploadProgress = {
  bytesUploaded: number;
  bytesTotal: number;
  percent: number;
  state: "uploading" | "paused" | "retrying" | "completed" | "cancelled" | "failed";
};

export type SupabaseGameplayUploadHandle = {
  abort: () => Promise<void>;
  pause: () => void;
  resume: () => void;
};

export type SupabaseGameplayUploadErrorCode =
  | "STORAGE_NOT_CONFIGURED"
  | "STORAGE_UPLOAD_FAILED"
  | "STORAGE_UPLOAD_INTERRUPTED"
  | "STORAGE_UPLOAD_EXPIRED"
  | "STORAGE_ACCESS_DENIED"
  | "STORAGE_RATE_LIMITED"
  | "STORAGE_UNAVAILABLE"
  | "UPLOAD_RESUME_FAILED"
  | "UNAUTHORIZED";

export class SupabaseGameplayUploadError extends Error {
  code: SupabaseGameplayUploadErrorCode;
  constructor(code: SupabaseGameplayUploadErrorCode, message: string) {
    super(message);
    this.name = "SupabaseGameplayUploadError";
    this.code = code;
  }
}

function assertApprovedEndpoint(endpoint: string, supabaseUrl: string): void {
  const allowed = new URL(`${supabaseUrl.replace(/\/$/, "")}/storage/v1/upload/resumable`);
  let target: URL;
  try {
    target = new URL(endpoint);
  } catch {
    throw new SupabaseGameplayUploadError(
      "STORAGE_NOT_CONFIGURED",
      "Invalid storage upload endpoint.",
    );
  }
  if (target.origin !== allowed.origin || target.pathname !== allowed.pathname) {
    throw new SupabaseGameplayUploadError(
      "STORAGE_ACCESS_DENIED",
      "Upload endpoint is not an approved Supabase Storage host.",
    );
  }
}

function mapTusError(err: unknown): SupabaseGameplayUploadError {
  const msg = err instanceof Error ? err.message : "Upload failed";
  const lower = msg.toLowerCase();
  if (lower.includes("401") || lower.includes("unauthorized")) {
    return new SupabaseGameplayUploadError("UNAUTHORIZED", "Sign in again to continue the upload.");
  }
  if (lower.includes("403") || lower.includes("forbidden") || lower.includes("rls")) {
    return new SupabaseGameplayUploadError(
      "STORAGE_ACCESS_DENIED",
      "You don't have access to upload this media.",
    );
  }
  if (lower.includes("429") || lower.includes("rate")) {
    return new SupabaseGameplayUploadError(
      "STORAGE_RATE_LIMITED",
      "Storage is rate limited. Wait a moment and try again.",
    );
  }
  if (lower.includes("expired")) {
    return new SupabaseGameplayUploadError(
      "STORAGE_UPLOAD_EXPIRED",
      "The upload session expired. Start a new upload.",
    );
  }
  if (lower.includes("network") || lower.includes("timeout") || lower.includes("interrupted")) {
    return new SupabaseGameplayUploadError(
      "STORAGE_UPLOAD_INTERRUPTED",
      "Upload was interrupted. You can resume if the session is still valid.",
    );
  }
  return new SupabaseGameplayUploadError("STORAGE_UPLOAD_FAILED", "Gameplay upload failed. Try again.");
}

async function currentAccessToken(): Promise<{ accessToken: string; anonKey: string; url: string }> {
  const config = readSupabaseBrowserConfig();
  const client = getSupabaseBrowserClient();
  if (!config || !client) {
    throw new SupabaseGameplayUploadError(
      "STORAGE_NOT_CONFIGURED",
      "Supabase browser client is not configured.",
    );
  }
  const { data, error } = await client.auth.getSession();
  if (error || !data.session?.access_token) {
    throw new SupabaseGameplayUploadError("UNAUTHORIZED", "Sign in to upload gameplay.");
  }
  return {
    accessToken: data.session.access_token,
    anonKey: config.anonKey,
    url: config.url,
  };
}

/**
 * Upload a File directly to the authorized private gameplay object via TUS.
 * Does not buffer the full file in application memory beyond tus chunking.
 */
export async function uploadGameplayViaSupabaseTus(input: {
  session: SupabaseGameplayUploadSession;
  file: File;
  onProgress?: (progress: UploadProgress) => void;
  signal?: AbortSignal;
}): Promise<{ uploadId: string; objectPath: string; bytesUploaded: number }> {
  const { session, file, onProgress, signal } = input;
  if (!session.bucket || !session.objectPath || !session.resumableEndpoint) {
    throw new SupabaseGameplayUploadError(
      "STORAGE_NOT_CONFIGURED",
      "Upload session is missing Supabase Storage fields.",
    );
  }
  if (file.size > session.maxBytes) {
    throw new SupabaseGameplayUploadError(
      "STORAGE_UPLOAD_FAILED",
      "Video file exceeds the maximum upload size.",
    );
  }

  const auth = await currentAccessToken();
  assertApprovedEndpoint(session.resumableEndpoint, auth.url);

  return new Promise((resolve, reject) => {
    let settled = false;
    let lastState: UploadProgress["state"] = "uploading";

    const upload = new tus.Upload(file, {
      endpoint: session.resumableEndpoint,
      retryDelays: [0, 1000, 3000, 5000, 10000, 20000],
      // Supabase currently requires 6 MiB chunks for resumable uploads.
      chunkSize: 6 * 1024 * 1024,
      uploadDataDuringCreation: true,
      removeFingerprintOnSuccess: true,
      storeFingerprintForResuming: true,
      headers: {
        authorization: `Bearer ${auth.accessToken}`,
        apikey: auth.anonKey,
        "x-upsert": "false",
      },
      metadata: {
        bucketName: session.bucket,
        objectName: session.objectPath,
        contentType: file.type || "video/mp4",
        cacheControl: "3600",
      },
      onError(error) {
        if (settled) return;
        settled = true;
        if (signal?.aborted) {
          onProgress?.({
            bytesUploaded: 0,
            bytesTotal: file.size,
            percent: 0,
            state: "cancelled",
          });
          reject(new SupabaseGameplayUploadError("STORAGE_UPLOAD_FAILED", "Upload cancelled"));
          return;
        }
        lastState = "failed";
        reject(mapTusError(error));
      },
      onProgress(bytesUploaded, bytesTotal) {
        const total = bytesTotal > 0 ? bytesTotal : file.size;
        const percent = total > 0 ? Math.min(100, Math.round((bytesUploaded / total) * 100)) : 0;
        onProgress?.({
          bytesUploaded,
          bytesTotal: total,
          percent,
          state: lastState === "retrying" ? "retrying" : "uploading",
        });
      },
      onShouldRetry(err, retryAttempt, options) {
        lastState = "retrying";
        const status = (err as { originalResponse?: { getStatus?: () => number } }).originalResponse
          ?.getStatus?.();
        if (status === 401 || status === 403) return false;
        if (signal?.aborted) return false;
        const max = options.retryDelays?.length ?? 0;
        return retryAttempt < max;
      },
      async onBeforeRequest(req) {
        // Refresh access token between chunks when the session was refreshed.
        try {
          const refreshed = await currentAccessToken();
          assertApprovedEndpoint(session.resumableEndpoint, refreshed.url);
          req.setHeader("authorization", `Bearer ${refreshed.accessToken}`);
          req.setHeader("apikey", refreshed.anonKey);
        } catch {
          // Keep prior headers; onError will surface auth failures.
        }
      },
      onSuccess() {
        if (settled) return;
        settled = true;
        onProgress?.({
          bytesUploaded: file.size,
          bytesTotal: file.size,
          percent: 100,
          state: "completed",
        });
        resolve({
          uploadId: session.uploadId,
          objectPath: session.objectPath,
          bytesUploaded: file.size,
        });
      },
    });

    const abort = () => {
      lastState = "cancelled";
      void upload.abort(true).catch(() => undefined);
      if (!settled) {
        settled = true;
        onProgress?.({
          bytesUploaded: 0,
          bytesTotal: file.size,
          percent: 0,
          state: "cancelled",
        });
        reject(new SupabaseGameplayUploadError("STORAGE_UPLOAD_FAILED", "Upload cancelled"));
      }
    };

    signal?.addEventListener("abort", abort, { once: true });

    // Attempt resume from previous fingerprint when available.
    upload.findPreviousUploads().then((previous) => {
      if (signal?.aborted) {
        abort();
        return;
      }
      if (previous.length > 0) {
        upload.resumeFromPreviousUpload(previous[0]!);
      }
      upload.start();
    }).catch(() => {
      if (signal?.aborted) {
        abort();
        return;
      }
      upload.start();
    });
  });
}
