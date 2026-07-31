/**
 * Upload session service — create, stream, complete, cancel.
 * No gameplay analysis in this phase.
 */
import { basename } from "node:path";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  assertDurationAllowed,
  buildGameContextFromSelection,
  calculateAbsoluteDeleteAt,
  calculateExpiresAt,
  classifyMediaDuration,
  createUploadSessionRequestSchema,
  isGameAcceptableForUpload,
  RELEASED_NOT_SUPPORTED_MESSAGE,
  RETENTION_POLICY_VERSION,
  SCOTTY_MAX_DURATION_SEC,
  type CreateUploadSessionRequest,
  type MediaClassification,
  type PublicUploadDetail,
  type PublicUploadSessionResponse,
  type ScottyErrorCode,
  type UploadGameplayContext,
} from "../scottyContract";
import { getMediaInspector } from "../media/inspector";
import { getMediaObjectStorage, type UploadWriteHandle } from "../mediaStorage";
import { getProfileRepository } from "../profile/repository";
import {
  getMaxUploadBytes,
  getMediaRetentionPolicy,
  getPendingUploadExpirationHours,
  retentionNoticeText,
} from "../retention/policy";
import { getUploadRepository, newUploadId, type MediaUploadRecord } from "./repository";
import { assertUploadTransition } from "./transitions";

export class UploadServiceError extends Error {
  constructor(
    public httpStatus: number,
    public code: ScottyErrorCode | "INVALID_REQUEST" | "UPLOAD_NOT_FOUND",
    message: string,
  ) {
    super(message);
    this.name = "UploadServiceError";
  }
}

function safeDisplayName(filename: string): string {
  const base = basename(filename).replace(/[^\w.\- ()[\]]+/g, "_").slice(0, 200);
  return base || "gameplay.mp4";
}

function logEvent(event: string, fields: Record<string, string | number | boolean | undefined>): void {
  const parts = Object.entries(fields)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${v}`);
  console.log(`[chelcoach-upload] event=${event} ${parts.join(" ")}`);
}

function toPublicDetail(rec: MediaUploadRecord): PublicUploadDetail {
  const hours = getMediaRetentionPolicy().rawMediaRetentionHours;
  return {
    uploadId: rec.uploadId,
    uploadStatus: rec.uploadStatus,
    displayFilename: rec.displayFilename,
    mimeType: rec.mimeType,
    byteSize: rec.storedByteSize ?? rec.declaredByteSize,
    durationSec: rec.trustedMedia?.durationSec,
    mediaClassification: rec.mediaClassification,
    context: rec.context,
    expiresAt: rec.expiresAt,
    absoluteDeleteAt: rec.absoluteDeleteAt,
    retentionHours: hours,
    retentionNotice: retentionNoticeText(hours),
    ...(rec.uploadStatus === "deleted"
      ? {
          sourceVideoExpiredMessage:
            "Source gameplay video expired and was deleted after the retention period. Your coaching report can remain available.",
        }
      : {}),
    errorCode: rec.errorCode,
    errorMessage: rec.errorMessage,
    createdAt: rec.createdAt,
    uploadedAt: rec.uploadedAt,
    readyAt: rec.readyAt,
  };
}

export async function createUploadSession(
  ownerId: string,
  body: unknown,
): Promise<PublicUploadSessionResponse> {
  // Opportunistic cleanup of abandoned pending sessions.
  await expireAbandonedUploads().catch(() => undefined);

  const parsed = createUploadSessionRequestSchema.safeParse(body);
  if (!parsed.success) {
    throw new UploadServiceError(400, "INVALID_REQUEST", "Invalid upload session request.");
  }
  const req = parsed.data;
  const maxBytes = getMaxUploadBytes();
  if (req.sizeBytes > maxBytes) {
    throw new UploadServiceError(413, "VIDEO_FILE_TOO_LARGE", "Video file exceeds the maximum upload size.");
  }

  // Rebuild game context from catalog so client cannot spoof supportStatus.
  const gameContext = buildGameContextFromSelection(req.context.gameContext.canonicalGameId, {
    selectedGameTitle: req.context.gameContext.selectedGameTitle,
  });
  if (!isGameAcceptableForUpload(gameContext.supportStatus)) {
    if (gameContext.supportStatus === "released_not_yet_supported") {
      throw new UploadServiceError(422, "GAME_NOT_YET_SUPPORTED", RELEASED_NOT_SUPPORTED_MESSAGE);
    }
    throw new UploadServiceError(422, "UNSUPPORTED_GAME", "This game is not supported.");
  }

  if (!req.context.singlePlayerControl) {
    throw new UploadServiceError(
      400,
      "INVALID_REQUEST",
      "Confirm that you control one player in this footage.",
    );
  }

  const context: UploadGameplayContext = {
    ...req.context,
    gameContext,
    playerContext: req.context.playerContext,
  };

  if (req.saveAsDefaults) {
    const profiles = getProfileRepository();
    await profiles.update(ownerId, {
      preferredPlatform: context.playerContext.platform,
      consoleGeneration: context.playerContext.consoleGeneration,
      preferredControlScheme: context.playerContext.controlScheme,
      primaryPosition: context.playerContext.position,
      commonGameMode: context.playerContext.gameMode,
      defaultIndicatorColor: context.playerContext.indicatorColor ?? null,
      defaultTeamSide: context.playerContext.teamSide,
      lastSelectedGameId: gameContext.canonicalGameId,
    });
    logEvent("profile_defaults_saved", { ownerId });
  }

  const now = new Date();
  const policy = getMediaRetentionPolicy();
  const uploadId = newUploadId();
  const media = getMediaObjectStorage();
  const objectKey = media.createObjectKey(ownerId, uploadId);
  const pendingHours = getPendingUploadExpirationHours();
  const pendingExpiresAt = new Date(now.getTime() + pendingHours * 3600_000).toISOString();

  const record: MediaUploadRecord = {
    uploadId,
    ownerId,
    storageProvider: media.backend,
    storageObjectKey: objectKey,
    originalFilename: req.filename,
    displayFilename: safeDisplayName(req.filename),
    mimeType: req.contentType,
    declaredByteSize: req.sizeBytes,
    clientDeclaredDurationSec: req.clientDeclaredDurationSec,
    uploadStatus: "pending",
    context,
    retentionPolicyVersion: RETENTION_POLICY_VERSION,
    expiresAt: calculateExpiresAt(now, policy).toISOString(),
    absoluteDeleteAt: calculateAbsoluteDeleteAt(now, policy).toISOString(),
    pendingExpiresAt,
    createdAt: now.toISOString(),
    deletionAttemptCount: 0,
  };

  await getUploadRepository().create(record);
  logEvent("upload_record_created", {
    uploadId,
    ownerId,
    byteSize: req.sizeBytes,
    status: "pending",
  });

  const hours = policy.rawMediaRetentionHours;
  return {
    uploadId,
    uploadStatus: "pending",
    uploadUrl: `/api/uploads/${uploadId}/content`,
    allowedMimeTypes: ["video/mp4", "video/quicktime"],
    maxBytes,
    expiresAt: record.expiresAt,
    retentionHours: hours,
    retentionNotice: retentionNoticeText(hours),
  };
}

export async function beginStreamedUpload(
  ownerId: string,
  uploadId: string,
): Promise<{ record: MediaUploadRecord; handle: UploadWriteHandle }> {
  const repo = getUploadRepository();
  const record = await repo.get(uploadId);
  if (!record) throw new UploadServiceError(404, "UPLOAD_NOT_FOUND", "Upload not found.");
  if (record.ownerId !== ownerId) {
    throw new UploadServiceError(403, "FORBIDDEN", "You don't have access to this upload.");
  }
  if (record.uploadStatus !== "pending" && record.uploadStatus !== "uploading") {
    throw new UploadServiceError(409, "INVALID_REQUEST", `Upload is "${record.uploadStatus}".`);
  }

  assertUploadTransition(record.uploadStatus, "uploading");
  await repo.update(uploadId, { uploadStatus: "uploading" });
  logEvent("upload_started", { uploadId, ownerId });

  const media = getMediaObjectStorage();
  const handle = await media.openWriteStream({
    objectKey: record.storageObjectKey,
    contentType: record.mimeType,
    maxBytes: getMaxUploadBytes(),
  });
  return { record, handle };
}

export async function finishStreamedUpload(
  ownerId: string,
  uploadId: string,
  source: Readable,
): Promise<PublicUploadDetail> {
  const { record, handle } = await beginStreamedUpload(ownerId, uploadId);
  const repo = getUploadRepository();
  const media = getMediaObjectStorage();

  try {
    logEvent("upload_transfer", { uploadId, ownerId, status: "streaming" });
    await pipeline(source, handle.writeStream as NodeJS.WritableStream);
    const stored = await handle.finalize();
    assertUploadTransition("uploading", "uploaded");
    await repo.update(uploadId, {
      uploadStatus: "uploaded",
      storedByteSize: stored.byteSize,
      uploadedAt: new Date().toISOString(),
    });
    logEvent("upload_completed", {
      uploadId,
      ownerId,
      byteSize: stored.byteSize,
    });
  } catch (err) {
    const code =
      err && typeof err === "object" && (err as { code?: string }).code === "VIDEO_FILE_TOO_LARGE"
        ? "VIDEO_FILE_TOO_LARGE"
        : "MEDIA_INSPECTION_FAILED";
    await handle.abort().catch(() => undefined);
    await media.deleteObject(record.storageObjectKey).catch(() => undefined);
    await repo.update(uploadId, {
      uploadStatus: "expired",
      errorCode: code as ScottyErrorCode,
      errorMessage:
        code === "VIDEO_FILE_TOO_LARGE"
          ? "Video file exceeds the maximum upload size."
          : "Upload failed.",
    });
    logEvent("validation_failed", { uploadId, ownerId, errorCode: code });
    throw new UploadServiceError(
      code === "VIDEO_FILE_TOO_LARGE" ? 413 : 400,
      code as ScottyErrorCode,
      code === "VIDEO_FILE_TOO_LARGE"
        ? "Video file exceeds the maximum upload size."
        : "Upload failed.",
    );
  }

  return completeUpload(ownerId, uploadId);
}

export async function completeUpload(ownerId: string, uploadId: string): Promise<PublicUploadDetail> {
  const repo = getUploadRepository();
  const record = await repo.get(uploadId);
  if (!record) throw new UploadServiceError(404, "UPLOAD_NOT_FOUND", "Upload not found.");
  if (record.ownerId !== ownerId) {
    throw new UploadServiceError(403, "FORBIDDEN", "You don't have access to this upload.");
  }
  if (record.uploadStatus === "ready") return toPublicDetail(record);
  if (record.uploadStatus !== "uploaded" && record.uploadStatus !== "processing") {
    throw new UploadServiceError(409, "INVALID_REQUEST", `Upload is "${record.uploadStatus}".`);
  }

  const media = getMediaObjectStorage();
  const exists = await media.exists(record.storageObjectKey);
  if (!exists) {
    await repo.update(uploadId, {
      uploadStatus: "expired",
      errorCode: "UPLOAD_NOT_FOUND",
      errorMessage: "Stored object missing.",
    });
    throw new UploadServiceError(404, "UPLOAD_NOT_FOUND", "Stored object missing.");
  }
  logEvent("storage_verified", { uploadId, ownerId });

  assertUploadTransition(record.uploadStatus === "processing" ? "processing" : "uploaded", "processing");
  await repo.update(uploadId, { uploadStatus: "processing" });
  logEvent("inspection_started", { uploadId, ownerId });

  const started = Date.now();
  let inspection;
  try {
    inspection = await getMediaInspector().inspect({
      uploadId,
      storageProvider: record.storageProvider,
      objectKey: record.storageObjectKey,
      declaredMimeType: record.mimeType,
    });
  } catch (err) {
    const code =
      (err as { code?: string }).code === "MEDIA_INSPECTION_FAILED"
        ? "MEDIA_INSPECTION_FAILED"
        : "MEDIA_INSPECTION_FAILED";
    await failAndScheduleCleanup(uploadId, code, "We couldn't inspect this video.");
    throw new UploadServiceError(422, code, "We couldn't inspect this video.");
  }

  const durationCheck = assertDurationAllowed(inspection.durationSeconds);
  if (!durationCheck.ok) {
    await failAndScheduleCleanup(uploadId, "VIDEO_DURATION_EXCEEDED", "Video exceeds the 30-minute maximum.");
    throw new UploadServiceError(422, "VIDEO_DURATION_EXCEEDED", "Video exceeds the 30-minute maximum.");
  }

  const maxBytes = getMaxUploadBytes();
  // Trusted size wins over client declaration.
  if (inspection.byteSize > maxBytes) {
    await failAndScheduleCleanup(uploadId, "VIDEO_FILE_TOO_LARGE", "Video file exceeds the maximum upload size.");
    throw new UploadServiceError(413, "VIDEO_FILE_TOO_LARGE", "Video file exceeds the maximum upload size.");
  }

  let classification: MediaClassification;
  try {
    classification = classifyMediaDuration(inspection.durationSeconds);
  } catch {
    await failAndScheduleCleanup(uploadId, "VIDEO_DURATION_EXCEEDED", "Video exceeds the 30-minute maximum.");
    throw new UploadServiceError(422, "VIDEO_DURATION_EXCEEDED", "Video exceeds the 30-minute maximum.");
  }

  const now = new Date();
  const policy = getMediaRetentionPolicy();
  const trustedMedia = {
    durationSec: Math.min(inspection.durationSeconds, SCOTTY_MAX_DURATION_SEC),
    width: inspection.width ?? 1,
    height: inspection.height ?? 1,
    fps: inspection.frameRate,
    codec: inspection.videoCodec,
    container: record.mimeType === "video/quicktime" ? "mov" : "mp4",
    inspectedAt: now.toISOString(),
  };

  assertUploadTransition("processing", "ready");
  const updated = await repo.update(uploadId, {
    uploadStatus: "ready",
    storedByteSize: inspection.byteSize,
    trustedMedia,
    mediaClassification: classification,
    context: {
      ...record.context,
      mediaClassification: classification,
    },
    expiresAt: calculateExpiresAt(now, policy).toISOString(),
    absoluteDeleteAt: calculateAbsoluteDeleteAt(now, policy).toISOString(),
    readyAt: now.toISOString(),
    errorCode: undefined,
    errorMessage: undefined,
  });

  logEvent("inspection_completed", {
    uploadId,
    ownerId,
    duration: Math.round(inspection.durationSeconds),
    byteSize: inspection.byteSize,
    mediaClassification: classification,
    elapsedMs: Date.now() - started,
  });
  logEvent("upload_ready", {
    uploadId,
    ownerId,
    mediaClassification: classification,
  });

  return toPublicDetail(updated);
}

async function failAndScheduleCleanup(
  uploadId: string,
  code: ScottyErrorCode,
  message: string,
): Promise<void> {
  const repo = getUploadRepository();
  const rec = await repo.get(uploadId);
  if (!rec) return;
  const media = getMediaObjectStorage();
  await media.deleteObject(rec.storageObjectKey).catch(() => undefined);
  await repo.update(uploadId, {
    uploadStatus: "expired",
    errorCode: code,
    errorMessage: message,
    deletedAt: new Date().toISOString(),
  });
  logEvent("partial_object_deleted", { uploadId, errorCode: code });
  logEvent("validation_failed", { uploadId, errorCode: code });
}

export async function getUploadForOwner(
  ownerId: string,
  uploadId: string,
): Promise<PublicUploadDetail> {
  const record = await getUploadRepository().get(uploadId);
  if (!record) throw new UploadServiceError(404, "UPLOAD_NOT_FOUND", "Upload not found.");
  if (record.ownerId !== ownerId) {
    throw new UploadServiceError(403, "FORBIDDEN", "You don't have access to this upload.");
  }
  return toPublicDetail(record);
}

/** Mark upload expired after an early Content-Length / size reject (no body streamed). */
export async function rejectOversizedUpload(ownerId: string, uploadId: string): Promise<void> {
  const repo = getUploadRepository();
  const record = await repo.get(uploadId);
  if (!record) throw new UploadServiceError(404, "UPLOAD_NOT_FOUND", "Upload not found.");
  if (record.ownerId !== ownerId) {
    throw new UploadServiceError(403, "FORBIDDEN", "You don't have access to this upload.");
  }
  await failAndScheduleCleanup(
    uploadId,
    "VIDEO_FILE_TOO_LARGE",
    "Video file exceeds the maximum upload size.",
  );
  logEvent("validation_failed", { uploadId, ownerId, errorCode: "VIDEO_FILE_TOO_LARGE" });
}

export async function cancelUpload(ownerId: string, uploadId: string): Promise<PublicUploadDetail> {
  const repo = getUploadRepository();
  const record = await repo.get(uploadId);
  if (!record) throw new UploadServiceError(404, "UPLOAD_NOT_FOUND", "Upload not found.");
  if (record.ownerId !== ownerId) {
    throw new UploadServiceError(403, "FORBIDDEN", "You don't have access to this upload.");
  }
  if (record.uploadStatus === "deleted" || record.uploadStatus === "expired") {
    return toPublicDetail(record);
  }
  const media = getMediaObjectStorage();
  await media.deleteObject(record.storageObjectKey).catch(() => undefined);
  const updated = await repo.update(uploadId, {
    uploadStatus: "expired",
    errorCode: "INVALID_REQUEST",
    errorMessage: "Upload cancelled.",
    deletedAt: new Date().toISOString(),
  });
  logEvent("upload_cancelled", { uploadId, ownerId });
  logEvent("partial_object_deleted", { uploadId, ownerId });
  return toPublicDetail(updated);
}

/** Expire abandoned pending/uploading sessions. */
export async function expireAbandonedUploads(now = new Date()): Promise<number> {
  const repo = getUploadRepository();
  const media = getMediaObjectStorage();
  const expired = await repo.listExpiredPending(now, 100);
  for (const rec of expired) {
    await media.deleteObject(rec.storageObjectKey).catch(() => undefined);
    await repo.update(rec.uploadId, {
      uploadStatus: "expired",
      errorCode: "UPLOAD_EXPIRED",
      errorMessage: "Pending upload expired.",
      deletedAt: now.toISOString(),
    });
    logEvent("pending_upload_expired", { uploadId: rec.uploadId, ownerId: rec.ownerId });
  }
  return expired.length;
}

export type { CreateUploadSessionRequest };
