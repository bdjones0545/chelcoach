/**
 * Raw upload metadata contract.
 * Raw video bytes must never appear in this schema — only storage references.
 */
import { z } from "zod";
import { storageProviderSchema, uploadStatusSchema } from "./enums";
import { RETENTION_POLICY_VERSION } from "./retention";

/** Maximum trusted video duration (30 minutes). */
export const SCOTTY_MAX_DURATION_SEC = 1800;

/**
 * Default max upload bytes — matches the current shared `uploadRules` (2 GB).
 * Override at runtime with CHELCOACH_MAX_UPLOAD_BYTES on the server.
 */
export const SCOTTY_DEFAULT_MAX_UPLOAD_BYTES = 2 * 1024 ** 3;

export const acceptedVideoMimeTypes = ["video/mp4", "video/quicktime"] as const;

export const processingLeaseRefSchema = z.object({
  leaseId: z.string().trim().min(1).max(128),
  status: z.enum(["active", "released", "expired", "revoked"]),
  expiresAt: z.string().datetime({ offset: true }),
  heartbeatAt: z.string().datetime({ offset: true }).optional(),
});
export type ProcessingLeaseRef = z.infer<typeof processingLeaseRefSchema>;

/**
 * Trusted media inspection result (backend-authored).
 * Client-supplied duration must not override these fields.
 */
export const trustedMediaMetadataSchema = z.object({
  durationSec: z.number().positive().max(SCOTTY_MAX_DURATION_SEC),
  width: z.number().int().positive().max(7680),
  height: z.number().int().positive().max(4320),
  fps: z.number().nonnegative().max(240).optional(),
  codec: z.string().trim().max(64).optional(),
  container: z.string().trim().max(64).optional(),
  inspectedAt: z.string().datetime({ offset: true }),
});
export type TrustedMediaMetadata = z.infer<typeof trustedMediaMetadataSchema>;

export const rawUploadMetadataSchema = z
  .object({
    uploadId: z.string().trim().min(1).max(128),
    ownerId: z.string().trim().min(1).max(128),
    originalFilename: z.string().trim().min(1).max(260),
    /** Sanitized name safe for UI display. */
    displayFilename: z.string().trim().min(1).max(260),
    mimeType: z.enum(acceptedVideoMimeTypes),
    byteSize: z.number().int().positive(),
    /** Client-declared duration when present — never authoritative. */
    clientDeclaredDurationSec: z.number().positive().max(SCOTTY_MAX_DURATION_SEC * 2).optional(),
    /** Trusted duration from media inspection when available. */
    durationSec: z.number().positive().max(SCOTTY_MAX_DURATION_SEC).optional(),
    trustedMedia: trustedMediaMetadataSchema.optional(),
    storageProvider: storageProviderSchema,
    storageObjectKey: z.string().trim().min(1).max(512),
    checksumSha256: z.string().trim().regex(/^[a-f0-9]{64}$/i).optional(),
    uploadStatus: uploadStatusSchema,
    createdAt: z.string().datetime({ offset: true }),
    uploadedAt: z.string().datetime({ offset: true }).optional(),
    expiresAt: z.string().datetime({ offset: true }),
    absoluteDeleteAt: z.string().datetime({ offset: true }),
    deletedAt: z.string().datetime({ offset: true }).optional(),
    deletionAttemptCount: z.number().int().nonnegative().max(1000).default(0),
    lastDeletionErrorCode: z.string().trim().max(80).optional(),
    retentionPolicyVersion: z.string().trim().min(1).max(64).default(RETENTION_POLICY_VERSION),
    processingLease: processingLeaseRefSchema.optional(),
    /** Early user-requested deletion after a safe terminal analysis state. */
    earlyDeletionRequestedAt: z.string().datetime({ offset: true }).optional(),
  })
  .strict();
export type RawUploadMetadata = z.infer<typeof rawUploadMetadataSchema>;

/** Public upload view — never exposes storageObjectKey or credentials. */
export const publicUploadViewSchema = z.object({
  uploadId: z.string(),
  displayFilename: z.string(),
  mimeType: z.enum(acceptedVideoMimeTypes),
  byteSize: z.number().int().positive(),
  durationSec: z.number().positive().max(SCOTTY_MAX_DURATION_SEC).optional(),
  uploadStatus: uploadStatusSchema,
  createdAt: z.string().datetime({ offset: true }),
  uploadedAt: z.string().datetime({ offset: true }).optional(),
  expiresAt: z.string().datetime({ offset: true }),
  deletedAt: z.string().datetime({ offset: true }).optional(),
  sourceVideoExpiredMessage: z.string().max(300).optional(),
});
export type PublicUploadView = z.infer<typeof publicUploadViewSchema>;

export const SOURCE_VIDEO_EXPIRED_MESSAGE =
  "Source gameplay video expired and was deleted after the retention period. Your coaching report remains available.";

/** Reject when trusted (or candidate) duration exceeds the 30-minute cap. */
export function assertDurationAllowed(
  durationSec: number,
): { ok: true } | { ok: false; code: "VIDEO_DURATION_EXCEEDED" } {
  if (!Number.isFinite(durationSec) || durationSec <= 0) {
    return { ok: false, code: "VIDEO_DURATION_EXCEEDED" };
  }
  if (durationSec > SCOTTY_MAX_DURATION_SEC) {
    return { ok: false, code: "VIDEO_DURATION_EXCEEDED" };
  }
  return { ok: true };
}

/**
 * Prefer trusted inspection duration over client-declared metadata.
 */
export function resolveTrustedDuration(input: {
  trustedDurationSec?: number;
  clientDeclaredDurationSec?: number;
}): number | undefined {
  if (input.trustedDurationSec !== undefined) return input.trustedDurationSec;
  return input.clientDeclaredDurationSec;
}

/** Ensure metadata objects cannot carry raw binary fields. */
export function assertNoRawMediaFields(value: unknown): void {
  if (!value || typeof value !== "object") return;
  const banned = ["bytes", "buffer", "base64", "data", "rawVideo", "videoBytes", "frameBytes"];
  for (const key of banned) {
    if (Object.prototype.hasOwnProperty.call(value, key)) {
      throw new Error(`raw media field forbidden in metadata: ${key}`);
    }
  }
}

export function toPublicUploadView(meta: RawUploadMetadata): PublicUploadView {
  const deleted = meta.uploadStatus === "deleted" || Boolean(meta.deletedAt);
  return publicUploadViewSchema.parse({
    uploadId: meta.uploadId,
    displayFilename: meta.displayFilename,
    mimeType: meta.mimeType,
    byteSize: meta.byteSize,
    durationSec: meta.durationSec ?? meta.trustedMedia?.durationSec,
    uploadStatus: meta.uploadStatus,
    createdAt: meta.createdAt,
    uploadedAt: meta.uploadedAt,
    expiresAt: meta.expiresAt,
    deletedAt: meta.deletedAt,
    ...(deleted ? { sourceVideoExpiredMessage: SOURCE_VIDEO_EXPIRED_MESSAGE } : {}),
  });
}
