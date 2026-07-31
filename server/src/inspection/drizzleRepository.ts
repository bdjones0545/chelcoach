/**
 * Postgres-backed media inspection jobs with atomic SKIP LOCKED claims.
 */
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { getDb } from "../db/client";
import { mediaInspectionJobs } from "../db/schema";
import type { MediaClassification, MediaInspectionStatus, ScottyErrorCode } from "../scottyContract";
import type { InspectionJobRepository } from "./repository";
import type { CreateInspectionJobInput, MediaInspectionJobRecord } from "./types";

const ACTIVE_STATUSES = [
  "queued",
  "claimed",
  "downloading",
  "inspecting",
  "validating",
] as const;

function rowToRecord(row: typeof mediaInspectionJobs.$inferSelect): MediaInspectionJobRecord {
  return {
    id: row.id,
    uploadId: row.uploadId,
    ownerId: row.ownerId,
    storageProvider: row.storageProvider,
    bucketAlias: row.bucketAlias,
    objectKey: row.objectKey,
    objectFingerprint: row.objectFingerprint,
    contractVersion: row.contractVersion,
    status: row.status as MediaInspectionStatus,
    attemptCount: row.attemptCount,
    maxAttempts: row.maxAttempts,
    workerId: row.workerId ?? undefined,
    claimedAt: row.claimedAt?.toISOString(),
    claimExpiresAt: row.claimExpiresAt?.toISOString(),
    heartbeatAt: row.heartbeatAt?.toISOString(),
    startedAt: row.startedAt?.toISOString(),
    completedAt: row.completedAt?.toISOString(),
    failedAt: row.failedAt?.toISOString(),
    nextAttemptAt: row.nextAttemptAt?.toISOString(),
    trustedByteSize: row.trustedByteSize ?? undefined,
    trustedMimeType: row.trustedMimeType ?? undefined,
    trustedDurationSec: row.trustedDurationSec ?? undefined,
    videoCodec: row.videoCodec ?? undefined,
    audioCodec: row.audioCodec ?? undefined,
    width: row.width ?? undefined,
    height: row.height ?? undefined,
    frameRate: row.frameRate ?? undefined,
    rotation: row.rotation ?? undefined,
    mediaClassification: (row.mediaClassification as MediaClassification | null) ?? undefined,
    errorCode: (row.errorCode as ScottyErrorCode | null) ?? undefined,
    errorMessage: row.errorMessage ?? undefined,
    retryable: row.retryable,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export class DrizzleInspectionJobRepository implements InspectionJobRepository {
  async create(input: CreateInspectionJobInput): Promise<MediaInspectionJobRecord> {
    const existing = await this.getByUploadAndFingerprint(input.uploadId, input.objectFingerprint);
    if (existing) {
      if (
        existing.status === "completed" ||
        ACTIVE_STATUSES.includes(existing.status as (typeof ACTIVE_STATUSES)[number])
      ) {
        return existing;
      }
    }

    const db = getDb();
    const now = new Date();
    try {
      const [row] = await db
        .insert(mediaInspectionJobs)
        .values({
          uploadId: input.uploadId,
          ownerId: input.ownerId,
          storageProvider: input.storageProvider,
          bucketAlias: input.bucketAlias,
          objectKey: input.objectKey,
          objectFingerprint: input.objectFingerprint,
          status: "queued",
          attemptCount: 0,
          maxAttempts: input.maxAttempts ?? 3,
          nextAttemptAt: now,
          trustedByteSize: input.trustedByteSize,
          trustedMimeType: input.trustedMimeType,
          retryable: true,
          version: 1,
        })
        .returning();
      return rowToRecord(row);
    } catch (err) {
      // Unique conflict — return existing
      const again = await this.getByUploadAndFingerprint(input.uploadId, input.objectFingerprint);
      if (again) return again;
      throw err;
    }
  }

  async get(jobId: string): Promise<MediaInspectionJobRecord | undefined> {
    const db = getDb();
    const [row] = await db
      .select()
      .from(mediaInspectionJobs)
      .where(eq(mediaInspectionJobs.id, jobId))
      .limit(1);
    return row ? rowToRecord(row) : undefined;
  }

  async getActiveByUpload(uploadId: string): Promise<MediaInspectionJobRecord | undefined> {
    const db = getDb();
    const [active] = await db
      .select()
      .from(mediaInspectionJobs)
      .where(
        and(
          eq(mediaInspectionJobs.uploadId, uploadId),
          inArray(mediaInspectionJobs.status, [...ACTIVE_STATUSES]),
        ),
      )
      .orderBy(asc(mediaInspectionJobs.createdAt))
      .limit(1);
    if (active) return rowToRecord(active);
    const [latest] = await db
      .select()
      .from(mediaInspectionJobs)
      .where(eq(mediaInspectionJobs.uploadId, uploadId))
      .orderBy(sql`${mediaInspectionJobs.createdAt} desc`)
      .limit(1);
    return latest ? rowToRecord(latest) : undefined;
  }

  async getByUploadAndFingerprint(
    uploadId: string,
    fingerprint: string,
  ): Promise<MediaInspectionJobRecord | undefined> {
    const db = getDb();
    const [row] = await db
      .select()
      .from(mediaInspectionJobs)
      .where(
        and(
          eq(mediaInspectionJobs.uploadId, uploadId),
          eq(mediaInspectionJobs.objectFingerprint, fingerprint),
        ),
      )
      .limit(1);
    return row ? rowToRecord(row) : undefined;
  }

  async update(
    jobId: string,
    patch: Partial<MediaInspectionJobRecord>,
    expectedVersion?: number,
  ): Promise<MediaInspectionJobRecord> {
    const db = getDb();
    const values: Record<string, unknown> = {
      updatedAt: new Date(),
      version: sql`${mediaInspectionJobs.version} + 1`,
    };
    if (patch.status !== undefined) values.status = patch.status;
    if (patch.attemptCount !== undefined) values.attemptCount = patch.attemptCount;
    if (patch.workerId !== undefined) values.workerId = patch.workerId;
    if (patch.claimedAt !== undefined)
      values.claimedAt = patch.claimedAt ? new Date(patch.claimedAt) : null;
    if (patch.claimExpiresAt !== undefined)
      values.claimExpiresAt = patch.claimExpiresAt ? new Date(patch.claimExpiresAt) : null;
    if (patch.heartbeatAt !== undefined)
      values.heartbeatAt = patch.heartbeatAt ? new Date(patch.heartbeatAt) : null;
    if (patch.startedAt !== undefined)
      values.startedAt = patch.startedAt ? new Date(patch.startedAt) : null;
    if (patch.completedAt !== undefined)
      values.completedAt = patch.completedAt ? new Date(patch.completedAt) : null;
    if (patch.failedAt !== undefined)
      values.failedAt = patch.failedAt ? new Date(patch.failedAt) : null;
    if (patch.nextAttemptAt !== undefined)
      values.nextAttemptAt = patch.nextAttemptAt ? new Date(patch.nextAttemptAt) : null;
    if (patch.trustedByteSize !== undefined) values.trustedByteSize = patch.trustedByteSize;
    if (patch.trustedMimeType !== undefined) values.trustedMimeType = patch.trustedMimeType;
    if (patch.trustedDurationSec !== undefined) values.trustedDurationSec = patch.trustedDurationSec;
    if (patch.videoCodec !== undefined) values.videoCodec = patch.videoCodec;
    if (patch.audioCodec !== undefined) values.audioCodec = patch.audioCodec;
    if (patch.width !== undefined) values.width = patch.width;
    if (patch.height !== undefined) values.height = patch.height;
    if (patch.frameRate !== undefined) values.frameRate = patch.frameRate;
    if (patch.rotation !== undefined) values.rotation = patch.rotation;
    if (patch.mediaClassification !== undefined)
      values.mediaClassification = patch.mediaClassification;
    if (patch.errorCode !== undefined) values.errorCode = patch.errorCode;
    if (patch.errorMessage !== undefined) values.errorMessage = patch.errorMessage;
    if (patch.retryable !== undefined) values.retryable = patch.retryable;

    const where =
      expectedVersion !== undefined
        ? and(eq(mediaInspectionJobs.id, jobId), eq(mediaInspectionJobs.version, expectedVersion))
        : eq(mediaInspectionJobs.id, jobId);

    const [row] = await db
      .update(mediaInspectionJobs)
      .set(values as Partial<typeof mediaInspectionJobs.$inferInsert>)
      .where(where)
      .returning();
    if (!row) throw Object.assign(new Error("VERSION_CONFLICT"), { code: "VERSION_CONFLICT" });
    return rowToRecord(row);
  }

  async claimNext(input: {
    workerId: string;
    now: Date;
    leaseMs: number;
  }): Promise<MediaInspectionJobRecord | null> {
    const db = getDb();
    const claimExpires = new Date(input.now.getTime() + input.leaseMs);

    // Atomic claim: SKIP LOCKED + update in one transaction.
    const result = await db.transaction(async (tx) => {
      const locked = await tx.execute(sql`
        SELECT id FROM media_inspection_jobs
        WHERE (
          (status = 'queued' AND (next_attempt_at IS NULL OR next_attempt_at <= ${input.now}))
          OR (
            status IN ('claimed', 'downloading', 'inspecting', 'validating')
            AND claim_expires_at IS NOT NULL
            AND claim_expires_at <= ${input.now}
          )
        )
        ORDER BY created_at ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      `);

      const lockedRows = Array.isArray(locked)
        ? (locked as Array<Record<string, unknown>>)
        : (((locked as unknown as { rows?: Array<Record<string, unknown>> }).rows) ?? []);
      const id = lockedRows[0] ? String(lockedRows[0].id ?? "") : "";
      if (!id) return null;

      const [row] = await tx
        .update(mediaInspectionJobs)
        .set({
          status: "claimed",
          workerId: input.workerId,
          claimedAt: input.now,
          claimExpiresAt: claimExpires,
          heartbeatAt: input.now,
          startedAt: sql`coalesce(${mediaInspectionJobs.startedAt}, ${input.now})`,
          attemptCount: sql`${mediaInspectionJobs.attemptCount} + 1`,
          version: sql`${mediaInspectionJobs.version} + 1`,
          updatedAt: input.now,
        })
        .where(eq(mediaInspectionJobs.id, id))
        .returning();
      return row ? rowToRecord(row) : null;
    });

    return result;
  }

  async listByUpload(uploadId: string): Promise<MediaInspectionJobRecord[]> {
    const db = getDb();
    const rows = await db
      .select()
      .from(mediaInspectionJobs)
      .where(eq(mediaInspectionJobs.uploadId, uploadId));
    return rows.map(rowToRecord);
  }

  async cancelActiveForUpload(uploadId: string, reason: string): Promise<number> {
    const db = getDb();
    const rows = await db
      .update(mediaInspectionJobs)
      .set({
        status: "cancelled",
        errorMessage: reason,
        retryable: false,
        version: sql`${mediaInspectionJobs.version} + 1`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(mediaInspectionJobs.uploadId, uploadId),
          inArray(mediaInspectionJobs.status, [...ACTIVE_STATUSES]),
        ),
      )
      .returning({ id: mediaInspectionJobs.id });
    return rows.length;
  }
}
