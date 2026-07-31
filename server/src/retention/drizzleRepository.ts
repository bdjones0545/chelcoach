/**
 * Postgres-backed retention repository (Step 10).
 * Deletion eligibility and cleanup locks are durable — not process memory.
 */
import { and, eq, gt, isNull, lte, ne, or, sql } from "drizzle-orm";
import type { ProcessingLease, RawUploadMetadata, ScottyReport, UploadStatus } from "../scottyContract";
import { getDb } from "../db/client";
import {
  confirmationFrames,
  mediaCleanupLocks,
  mediaUploads,
  processingLeases,
  scottyAnalysisJobs,
  scottyAnalysisReports,
} from "../db/schema";
import type { RetentionRepository, RetentionUploadRecord } from "./repository";

function uploadRowToMeta(row: typeof mediaUploads.$inferSelect): RawUploadMetadata {
  const trusted = row.trustedMedia;
  return {
    uploadId: row.id,
    ownerId: row.ownerId,
    originalFilename: row.originalFilename,
    displayFilename: row.displayFilename,
    mimeType: row.mimeType as RawUploadMetadata["mimeType"],
    byteSize: row.byteSize,
    clientDeclaredDurationSec: row.clientDeclaredDurationSec ?? undefined,
    durationSec: trusted?.durationSec,
    trustedMedia: trusted ?? undefined,
    storageProvider: row.storageProvider as RawUploadMetadata["storageProvider"],
    storageObjectKey: row.storageObjectKey ?? "",
    checksumSha256: row.checksumSha256 ?? undefined,
    uploadStatus: row.uploadStatus as UploadStatus,
    createdAt: row.createdAt.toISOString(),
    uploadedAt: row.uploadedAt?.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    absoluteDeleteAt: row.absoluteDeleteAt.toISOString(),
    deletedAt: row.deletedAt?.toISOString(),
    deletionAttemptCount: row.deletionAttemptCount,
    lastDeletionErrorCode: row.lastDeletionErrorCode ?? undefined,
    retentionPolicyVersion: row.retentionPolicyVersion,
    earlyDeletionRequestedAt: row.earlyDeletionRequestedAt?.toISOString(),
  };
}

async function derivedKeysForUpload(uploadId: string): Promise<string[]> {
  const db = getDb();
  const frames = await db
    .select({ key: confirmationFrames.storageObjectKey })
    .from(confirmationFrames)
    .where(
      and(eq(confirmationFrames.uploadId, uploadId), isNull(confirmationFrames.deletedAt)),
    );
  return frames.map((f) => f.key).filter(Boolean);
}

async function jobTerminalForUpload(
  uploadId: string,
): Promise<RetentionUploadRecord["jobTerminalStatus"]> {
  const db = getDb();
  const [job] = await db
    .select({
      status: scottyAnalysisJobs.canonicalStatus,
      reportId: scottyAnalysisJobs.reportId,
    })
    .from(scottyAnalysisJobs)
    .where(eq(scottyAnalysisJobs.uploadId, uploadId))
    .limit(1);
  if (!job) return "none";
  if (job.status === "completed") return "completed";
  if (job.status === "failed") return "failed";
  if (job.status === "cancelled") return "cancelled";
  return "active";
}

async function reportIdForUpload(uploadId: string): Promise<string | undefined> {
  const db = getDb();
  const [job] = await db
    .select({ reportId: scottyAnalysisJobs.reportId })
    .from(scottyAnalysisJobs)
    .where(eq(scottyAnalysisJobs.uploadId, uploadId))
    .limit(1);
  return job?.reportId ?? undefined;
}

async function toRetentionRecord(
  row: typeof mediaUploads.$inferSelect,
): Promise<RetentionUploadRecord> {
  return {
    meta: uploadRowToMeta(row),
    derivedObjectKeys: await derivedKeysForUpload(row.id),
    jobTerminalStatus: await jobTerminalForUpload(row.id),
    reportId: await reportIdForUpload(row.id),
  };
}

export class DrizzleRetentionRepository implements RetentionRepository {
  async listDeletionCandidates(now: Date, limit: number): Promise<RetentionUploadRecord[]> {
    const db = getDb();
    const rows = await db
      .select()
      .from(mediaUploads)
      .where(
        and(
          ne(mediaUploads.uploadStatus, "deleted"),
          or(
            lte(mediaUploads.expiresAt, now),
            lte(mediaUploads.absoluteDeleteAt, now),
            eq(mediaUploads.uploadStatus, "delete_failed"),
            sql`${mediaUploads.earlyDeletionRequestedAt} is not null`,
          ),
        ),
      )
      .limit(limit);
    const out: RetentionUploadRecord[] = [];
    for (const row of rows) {
      out.push(await toRetentionRecord(row));
    }
    return out;
  }

  async getUpload(uploadId: string): Promise<RetentionUploadRecord | undefined> {
    const db = getDb();
    const [row] = await db
      .select()
      .from(mediaUploads)
      .where(eq(mediaUploads.id, uploadId))
      .limit(1);
    if (!row) return undefined;
    return toRetentionRecord(row);
  }

  async getActiveLease(uploadId: string, now: Date): Promise<ProcessingLease | undefined> {
    const db = getDb();
    const [row] = await db
      .select()
      .from(processingLeases)
      .where(
        and(
          eq(processingLeases.uploadId, uploadId),
          eq(processingLeases.status, "active"),
          gt(processingLeases.expiresAt, now),
          isNull(processingLeases.releasedAt),
        ),
      )
      .limit(1);
    if (!row) return undefined;
    return {
      leaseId: row.id,
      uploadId: row.uploadId,
      analysisJobId: row.analysisJobId,
      acquiredAt: row.acquiredAt.toISOString(),
      heartbeatAt: row.heartbeatAt.toISOString(),
      expiresAt: row.expiresAt.toISOString(),
      releasedAt: row.releasedAt?.toISOString(),
      status: row.status as ProcessingLease["status"],
    };
  }

  async updateUploadStatus(
    uploadId: string,
    status: UploadStatus,
    patch?: Partial<RawUploadMetadata>,
  ): Promise<void> {
    const db = getDb();
    const values: Partial<typeof mediaUploads.$inferInsert> = {
      uploadStatus: status,
      updatedAt: new Date(),
    };
    if (patch?.deletedAt !== undefined) {
      values.deletedAt = patch.deletedAt ? new Date(patch.deletedAt) : null;
    }
    if (patch?.deletionAttemptCount !== undefined) {
      values.deletionAttemptCount = patch.deletionAttemptCount;
    }
    if (patch?.lastDeletionErrorCode !== undefined) {
      values.lastDeletionErrorCode = patch.lastDeletionErrorCode ?? null;
    }
    if (patch?.earlyDeletionRequestedAt !== undefined) {
      values.earlyDeletionRequestedAt = patch.earlyDeletionRequestedAt
        ? new Date(patch.earlyDeletionRequestedAt)
        : null;
    }
    if (patch?.storageObjectKey !== undefined) {
      values.storageObjectKey = patch.storageObjectKey || null;
    }
    await db.update(mediaUploads).set(values).where(eq(mediaUploads.id, uploadId));
  }

  async clearStorageRefs(uploadId: string): Promise<void> {
    const db = getDb();
    await db
      .update(mediaUploads)
      .set({ storageObjectKey: null, updatedAt: new Date() })
      .where(eq(mediaUploads.id, uploadId));
    await db
      .update(confirmationFrames)
      .set({ deletedAt: new Date() })
      .where(eq(confirmationFrames.uploadId, uploadId));
  }

  async getReport(reportId: string): Promise<ScottyReport | undefined> {
    const db = getDb();
    const [row] = await db
      .select()
      .from(scottyAnalysisReports)
      .where(eq(scottyAnalysisReports.id, reportId))
      .limit(1);
    return row ? (row.report as ScottyReport) : undefined;
  }

  async markJobFailedForRetention(uploadId: string, code: string): Promise<void> {
    const db = getDb();
    await db
      .update(scottyAnalysisJobs)
      .set({
        canonicalStatus: "failed",
        safeErrorCode: code,
        failedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(scottyAnalysisJobs.uploadId, uploadId),
          ne(scottyAnalysisJobs.canonicalStatus, "completed"),
          ne(scottyAnalysisJobs.canonicalStatus, "cancelled"),
          ne(scottyAnalysisJobs.canonicalStatus, "failed"),
        ),
      );
  }

  async tryAcquireCleanupLock(
    uploadId: string,
    owner: string,
    now: Date,
    ttlMs: number,
  ): Promise<boolean> {
    const db = getDb();
    const expiresAt = new Date(now.getTime() + ttlMs);

    return db.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(mediaCleanupLocks)
        .where(eq(mediaCleanupLocks.uploadId, uploadId))
        .for("update");

      if (existing?.active && existing.expiresAt.getTime() > now.getTime() && existing.owner !== owner) {
        return false;
      }

      if (existing) {
        await tx
          .update(mediaCleanupLocks)
          .set({
            owner,
            expiresAt,
            acquiredAt: now,
            active: true,
          })
          .where(eq(mediaCleanupLocks.uploadId, uploadId));
        return true;
      }

      await tx.insert(mediaCleanupLocks).values({
        uploadId,
        owner,
        expiresAt,
        acquiredAt: now,
        active: true,
      });
      return true;
    });
  }

  async releaseCleanupLock(uploadId: string, owner: string): Promise<void> {
    const db = getDb();
    await db
      .update(mediaCleanupLocks)
      .set({ active: false })
      .where(and(eq(mediaCleanupLocks.uploadId, uploadId), eq(mediaCleanupLocks.owner, owner)));
  }
}
