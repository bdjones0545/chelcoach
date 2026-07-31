/**
 * Postgres-backed upload repository (used when DATABASE_URL is set).
 * Raw video bytes are never written to Postgres — only metadata + storage refs.
 */
import { and, eq, inArray, lte } from "drizzle-orm";
import { getDb } from "../db/client";
import { mediaUploads } from "../db/schema";
import type {
  MediaClassification,
  ScottyErrorCode,
  TrustedMediaMetadata,
  UploadGameplayContext,
  UploadStatus,
} from "../scottyContract";
import type { MediaUploadRecord, UploadRepository } from "./repository";

function rowToRecord(row: typeof mediaUploads.$inferSelect): MediaUploadRecord {
  return {
    uploadId: row.id,
    ownerId: row.ownerId,
    storageProvider: row.storageProvider,
    storageObjectKey: row.storageObjectKey ?? "",
    originalFilename: row.originalFilename,
    displayFilename: row.displayFilename,
    mimeType: row.mimeType as "video/mp4" | "video/quicktime",
    declaredByteSize: row.byteSize,
    storedByteSize: row.byteSize,
    clientDeclaredDurationSec: row.clientDeclaredDurationSec ?? undefined,
    trustedMedia: (row.trustedMedia as TrustedMediaMetadata | null) ?? undefined,
    mediaClassification: (row.mediaClassification as MediaClassification | null) ?? undefined,
    uploadStatus: row.uploadStatus as UploadStatus,
    context: (row.gameplayContext as UploadGameplayContext) ?? {
      gameContext: {
        selectedGameTitle: "Unknown",
        canonicalGameId: "unknown",
        supportStatus: "unknown",
        mismatchState: "unsupported_selection",
      },
      playerContext: {
        platform: "unknown",
        controlScheme: "unknown",
        position: "unknown",
        gameMode: "unknown",
      },
      singlePlayerControl: true,
    },
    retentionPolicyVersion: row.retentionPolicyVersion,
    expiresAt: row.expiresAt.toISOString(),
    absoluteDeleteAt: row.absoluteDeleteAt.toISOString(),
    pendingExpiresAt: (row.pendingExpiresAt ?? row.expiresAt).toISOString(),
    createdAt: row.createdAt.toISOString(),
    uploadedAt: row.uploadedAt?.toISOString(),
    readyAt: row.readyAt?.toISOString(),
    deletedAt: row.deletedAt?.toISOString(),
    deletionAttemptCount: row.deletionAttemptCount,
    lastDeletionErrorCode: row.lastDeletionErrorCode ?? undefined,
    earlyDeletionRequestedAt: row.earlyDeletionRequestedAt?.toISOString(),
    errorCode: (row.errorCode as ScottyErrorCode | null) ?? undefined,
    errorMessage: row.errorMessage ?? undefined,
  };
}

export class DrizzleUploadRepository implements UploadRepository {
  async create(record: MediaUploadRecord): Promise<MediaUploadRecord> {
    const db = getDb();
    const [row] = await db
      .insert(mediaUploads)
      .values({
        id: record.uploadId,
        ownerId: record.ownerId,
        storageProvider: record.storageProvider,
        storageObjectKey: record.storageObjectKey,
        originalFilename: record.originalFilename,
        displayFilename: record.displayFilename,
        mimeType: record.mimeType,
        byteSize: record.declaredByteSize,
        clientDeclaredDurationSec: record.clientDeclaredDurationSec,
        trustedMedia: record.trustedMedia,
        mediaClassification: record.mediaClassification,
        gameplayContext: record.context,
        uploadStatus: record.uploadStatus,
        retentionPolicyVersion: record.retentionPolicyVersion,
        expiresAt: new Date(record.expiresAt),
        absoluteDeleteAt: new Date(record.absoluteDeleteAt),
        pendingExpiresAt: new Date(record.pendingExpiresAt),
        uploadedAt: record.uploadedAt ? new Date(record.uploadedAt) : null,
        readyAt: record.readyAt ? new Date(record.readyAt) : null,
        deletedAt: record.deletedAt ? new Date(record.deletedAt) : null,
        deletionAttemptCount: record.deletionAttemptCount,
        lastDeletionErrorCode: record.lastDeletionErrorCode,
        errorCode: record.errorCode,
        errorMessage: record.errorMessage,
      })
      .returning();
    return rowToRecord(row);
  }

  async get(uploadId: string): Promise<MediaUploadRecord | undefined> {
    const db = getDb();
    const [row] = await db.select().from(mediaUploads).where(eq(mediaUploads.id, uploadId)).limit(1);
    return row ? rowToRecord(row) : undefined;
  }

  async update(uploadId: string, patch: Partial<MediaUploadRecord>): Promise<MediaUploadRecord> {
    const db = getDb();
    const values: Partial<typeof mediaUploads.$inferInsert> = {
      updatedAt: new Date(),
    };
    if (patch.storageObjectKey !== undefined) values.storageObjectKey = patch.storageObjectKey;
    if (patch.storedByteSize !== undefined) values.byteSize = patch.storedByteSize;
    if (patch.declaredByteSize !== undefined && patch.storedByteSize === undefined) {
      values.byteSize = patch.declaredByteSize;
    }
    if (patch.trustedMedia !== undefined) values.trustedMedia = patch.trustedMedia;
    if (patch.mediaClassification !== undefined) values.mediaClassification = patch.mediaClassification;
    if (patch.context !== undefined) values.gameplayContext = patch.context;
    if (patch.uploadStatus !== undefined) values.uploadStatus = patch.uploadStatus;
    if (patch.expiresAt !== undefined) values.expiresAt = new Date(patch.expiresAt);
    if (patch.absoluteDeleteAt !== undefined) values.absoluteDeleteAt = new Date(patch.absoluteDeleteAt);
    if (patch.pendingExpiresAt !== undefined) values.pendingExpiresAt = new Date(patch.pendingExpiresAt);
    if (patch.uploadedAt !== undefined) values.uploadedAt = new Date(patch.uploadedAt);
    if (patch.readyAt !== undefined) values.readyAt = new Date(patch.readyAt);
    if (patch.deletedAt !== undefined) values.deletedAt = new Date(patch.deletedAt);
    if (patch.deletionAttemptCount !== undefined) values.deletionAttemptCount = patch.deletionAttemptCount;
    if (patch.lastDeletionErrorCode !== undefined) values.lastDeletionErrorCode = patch.lastDeletionErrorCode;
    if (patch.earlyDeletionRequestedAt !== undefined) {
      values.earlyDeletionRequestedAt = patch.earlyDeletionRequestedAt
        ? new Date(patch.earlyDeletionRequestedAt)
        : null;
    }
    if (patch.errorCode !== undefined) values.errorCode = patch.errorCode;
    if (patch.errorMessage !== undefined) values.errorMessage = patch.errorMessage;

    const [row] = await db
      .update(mediaUploads)
      .set(values)
      .where(eq(mediaUploads.id, uploadId))
      .returning();
    if (!row) throw new Error("UPLOAD_NOT_FOUND");
    return rowToRecord(row);
  }

  async listExpiredPending(now: Date, limit: number): Promise<MediaUploadRecord[]> {
    const db = getDb();
    const rows = await db
      .select()
      .from(mediaUploads)
      .where(
        and(
          inArray(mediaUploads.uploadStatus, ["pending", "uploading"]),
          lte(mediaUploads.pendingExpiresAt, now),
        ),
      )
      .limit(limit);
    return rows.map(rowToRecord);
  }
}
