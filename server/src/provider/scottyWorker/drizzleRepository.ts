/**
 * Postgres-backed worker job repository. The claim is a single transaction with
 * FOR UPDATE SKIP LOCKED so concurrent cron invocations never process the same job.
 */
import { eq, inArray, sql } from "drizzle-orm";
import { getDb } from "../../db/client";
import { scottyWorkerJobs } from "../../db/schema";
import type {
  ScottyAnalysisSubmission,
  ScottyErrorCode,
  ScottyJobStatus,
  ScottyReport,
} from "../../scottyContract";
import type { ScottyWorkerJobRepository } from "./repository";
import { ACTIVE_STATUSES, type ScottyRemoteDispatch, type ScottyWorkerJob, type ScottyWorkerJobPatch, type ScottyWorkerModelUsage } from "./types";

type Row = typeof scottyWorkerJobs.$inferSelect;

function iso(d: Date | null | undefined): string | undefined {
  return d ? d.toISOString() : undefined;
}

function rowToJob(row: Row): ScottyWorkerJob {
  return {
    externalJobId: row.externalJobId,
    applicationRequestId: row.applicationRequestId,
    uploadId: row.uploadId,
    ownerReference: row.ownerReference,
    idempotencyKey: row.idempotencyKey,
    requestFingerprint: row.requestFingerprint,
    contractVersion: row.contractVersion,
    submission: row.submission as ScottyAnalysisSubmission,
    status: row.status as ScottyJobStatus,
    sequenceNumber: row.sequenceNumber,
    attemptCount: row.attemptCount,
    maxAttempts: row.maxAttempts,
    workerId: row.workerId ?? undefined,
    claimExpiresAt: iso(row.claimExpiresAt),
    nextAttemptAt: iso(row.nextAttemptAt),
    acceptedAt: row.acceptedAt.toISOString(),
    startedAt: iso(row.startedAt),
    completedAt: iso(row.completedAt),
    failedAt: iso(row.failedAt),
    cancelledAt: iso(row.cancelledAt),
    cancelReason: row.cancelReason ?? undefined,
    errorCode: (row.errorCode as ScottyErrorCode | null) ?? undefined,
    errorMessage: row.errorMessage ?? undefined,
    retryable: row.retryable,
    report: (row.report as ScottyReport | null) ?? undefined,
    frameCount: row.frameCount ?? undefined,
    modelUsage: (row.modelUsage as ScottyWorkerModelUsage | null) ?? undefined,
    remote: (row.remote as ScottyRemoteDispatch | null) ?? undefined,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toDate(v: string | undefined): Date | null | undefined {
  if (v === undefined) return undefined;
  return v ? new Date(v) : null;
}

function patchToSet(patch: ScottyWorkerJobPatch): Partial<typeof scottyWorkerJobs.$inferInsert> {
  const set: Partial<typeof scottyWorkerJobs.$inferInsert> = { updatedAt: new Date() };
  if ("status" in patch && patch.status) set.status = patch.status;
  if ("sequenceNumber" in patch && patch.sequenceNumber !== undefined) set.sequenceNumber = patch.sequenceNumber;
  if ("attemptCount" in patch && patch.attemptCount !== undefined) set.attemptCount = patch.attemptCount;
  if ("workerId" in patch) set.workerId = patch.workerId ?? null;
  if ("claimExpiresAt" in patch) set.claimExpiresAt = toDate(patch.claimExpiresAt) ?? null;
  if ("nextAttemptAt" in patch) set.nextAttemptAt = toDate(patch.nextAttemptAt) ?? null;
  if ("startedAt" in patch) set.startedAt = toDate(patch.startedAt) ?? null;
  if ("completedAt" in patch) set.completedAt = toDate(patch.completedAt) ?? null;
  if ("failedAt" in patch) set.failedAt = toDate(patch.failedAt) ?? null;
  if ("cancelledAt" in patch) set.cancelledAt = toDate(patch.cancelledAt) ?? null;
  if ("cancelReason" in patch) set.cancelReason = patch.cancelReason ?? null;
  if ("errorCode" in patch) set.errorCode = patch.errorCode ?? null;
  if ("errorMessage" in patch) set.errorMessage = patch.errorMessage ?? null;
  if ("retryable" in patch && patch.retryable !== undefined) set.retryable = patch.retryable;
  if ("report" in patch) set.report = patch.report ?? null;
  if ("frameCount" in patch) set.frameCount = patch.frameCount ?? null;
  if ("modelUsage" in patch) set.modelUsage = patch.modelUsage ?? null;
  if ("remote" in patch) set.remote = patch.remote ?? null;
  return set;
}

export class DrizzleScottyWorkerJobRepository implements ScottyWorkerJobRepository {
  async create(job: ScottyWorkerJob): Promise<ScottyWorkerJob> {
    const db = getDb();
    const existing = await this.getByIdempotencyKey(job.idempotencyKey);
    if (existing) return existing;
    const [row] = await db
      .insert(scottyWorkerJobs)
      .values({
        externalJobId: job.externalJobId,
        applicationRequestId: job.applicationRequestId,
        uploadId: job.uploadId,
        ownerReference: job.ownerReference,
        idempotencyKey: job.idempotencyKey,
        requestFingerprint: job.requestFingerprint,
        contractVersion: job.contractVersion,
        submission: job.submission,
        status: job.status,
        sequenceNumber: job.sequenceNumber,
        attemptCount: job.attemptCount,
        maxAttempts: job.maxAttempts,
        acceptedAt: new Date(job.acceptedAt),
        retryable: job.retryable,
        createdAt: new Date(job.createdAt),
        updatedAt: new Date(job.updatedAt),
      })
      .onConflictDoNothing({ target: scottyWorkerJobs.idempotencyKey })
      .returning();
    if (row) return rowToJob(row);
    const raced = await this.getByIdempotencyKey(job.idempotencyKey);
    if (!raced) throw new Error("SCOTTY_WORKER_JOB_CREATE_FAILED");
    return raced;
  }

  async getByExternalJobId(externalJobId: string): Promise<ScottyWorkerJob | null> {
    const [row] = await getDb()
      .select()
      .from(scottyWorkerJobs)
      .where(eq(scottyWorkerJobs.externalJobId, externalJobId))
      .limit(1);
    return row ? rowToJob(row) : null;
  }

  async getByIdempotencyKey(idempotencyKey: string): Promise<ScottyWorkerJob | null> {
    const [row] = await getDb()
      .select()
      .from(scottyWorkerJobs)
      .where(eq(scottyWorkerJobs.idempotencyKey, idempotencyKey))
      .limit(1);
    return row ? rowToJob(row) : null;
  }

  async update(externalJobId: string, patch: ScottyWorkerJobPatch): Promise<ScottyWorkerJob> {
    const [row] = await getDb()
      .update(scottyWorkerJobs)
      .set(patchToSet(patch))
      .where(eq(scottyWorkerJobs.externalJobId, externalJobId))
      .returning();
    if (!row) throw new Error("SCOTTY_WORKER_JOB_NOT_FOUND");
    return rowToJob(row);
  }

  async claimNext(input: { workerId: string; now: Date; leaseMs: number }): Promise<ScottyWorkerJob | null> {
    const db = getDb();
    const claimExpires = new Date(input.now.getTime() + input.leaseMs);
    return db.transaction(async (tx) => {
      const locked = await tx.execute(sql`
        SELECT external_job_id FROM scotty_worker_jobs
        WHERE status IN ('queued', 'inspecting_input', 'extracting_frames', 'identifying_controlled_player', 'awaiting_player_confirmation', 'validating_player_identity', 'analyzing_gameplay', 'validating_report', 'finalizing')
          AND cancelled_at IS NULL
          AND (next_attempt_at IS NULL OR next_attempt_at <= ${input.now})
          AND (claim_expires_at IS NULL OR claim_expires_at <= ${input.now})
        ORDER BY created_at ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      `);
      const rows = Array.isArray(locked)
        ? (locked as Array<Record<string, unknown>>)
        : (((locked as unknown as { rows?: Array<Record<string, unknown>> }).rows) ?? []);
      const id = rows[0] ? String(rows[0].external_job_id ?? "") : "";
      if (!id) return null;
      const [row] = await tx
        .update(scottyWorkerJobs)
        .set({
          workerId: input.workerId,
          claimExpiresAt: claimExpires,
          attemptCount: sql`${scottyWorkerJobs.attemptCount} + 1`,
          startedAt: sql`coalesce(${scottyWorkerJobs.startedAt}, ${input.now})`,
          updatedAt: input.now,
        })
        .where(eq(scottyWorkerJobs.externalJobId, id))
        .returning();
      return row ? rowToJob(row) : null;
    });
  }

  async listActive(): Promise<ScottyWorkerJob[]> {
    const rows = await getDb()
      .select()
      .from(scottyWorkerJobs)
      .where(inArray(scottyWorkerJobs.status, [...ACTIVE_STATUSES] as ScottyJobStatus[]));
    return rows.map(rowToJob);
  }

  clear(): void {
    // Tests truncate via SQL.
  }
}
