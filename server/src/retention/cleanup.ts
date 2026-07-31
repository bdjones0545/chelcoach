/**
 * Media retention cleanup foundation (Step 1).
 *
 * Suggested eventual cadence: once per hour (single batch job, not per-upload timers).
 * Uses repository locks + re-read eligibility; fake storage in CI.
 *
 * Never logs raw video, frames, signed URLs, or credentials.
 */
import { randomUUID } from "node:crypto";
import {
  evaluateRetention,
  type RetentionDecision,
  type ScottyErrorCode,
} from "../scottyContract";
import type { ObjectStorage } from "../storage";
import { getMediaRetentionPolicy } from "./policy";
import type { RetentionRepository, RetentionUploadRecord } from "./repository";

export interface DeletionCandidate {
  uploadId: string;
  ownerId: string;
  storageProvider: string;
  storageObjectKey: string;
  derivedObjectKeys: string[];
  byteSize: number;
  durationSec?: number;
  uploadStatus: string;
  expiresAt: string;
  absoluteDeleteAt: string;
  deletionAttemptCount: number;
  jobTerminalStatus: RetentionUploadRecord["jobTerminalStatus"];
  reportId?: string;
}

export interface DeletionResult {
  uploadId: string;
  ok: boolean;
  alreadyAbsent: boolean;
  status: "deleted" | "delete_failed" | "deferred" | "skipped";
  errorCode?: ScottyErrorCode;
  attemptCount: number;
  reportRetained: boolean;
}

export interface CleanupBatchOptions {
  now?: Date;
  limit?: number;
  workerId?: string;
}

export interface CleanupBatchResult {
  examined: number;
  deleted: number;
  deferred: number;
  failed: number;
  skipped: number;
  forcedExpiredJobs: number;
  results: DeletionResult[];
}

export interface MediaRetentionService {
  findDeletionCandidates(now: Date): Promise<DeletionCandidate[]>;
  evaluateCandidate(candidate: DeletionCandidate, now: Date): Promise<RetentionDecision>;
  deleteCandidate(candidate: DeletionCandidate, now?: Date): Promise<DeletionResult>;
  runCleanupBatch(options?: CleanupBatchOptions): Promise<CleanupBatchResult>;
}

const DEFAULT_BATCH = 50;
const LOCK_TTL_MS = 60_000;

function toCandidate(rec: RetentionUploadRecord): DeletionCandidate {
  return {
    uploadId: rec.meta.uploadId,
    ownerId: rec.meta.ownerId,
    storageProvider: rec.meta.storageProvider,
    storageObjectKey: rec.meta.storageObjectKey,
    derivedObjectKeys: [...rec.derivedObjectKeys],
    byteSize: rec.meta.byteSize,
    durationSec: rec.meta.durationSec ?? rec.meta.trustedMedia?.durationSec,
    uploadStatus: rec.meta.uploadStatus,
    expiresAt: rec.meta.expiresAt,
    absoluteDeleteAt: rec.meta.absoluteDeleteAt,
    deletionAttemptCount: rec.meta.deletionAttemptCount ?? 0,
    jobTerminalStatus: rec.jobTerminalStatus,
    reportId: rec.reportId,
  };
}

export function createMediaRetentionService(deps: {
  repo: RetentionRepository;
  storage: ObjectStorage;
}): MediaRetentionService {
  const { repo, storage } = deps;
  let batchRunning = false;

  async function findDeletionCandidates(now: Date): Promise<DeletionCandidate[]> {
    const rows = await repo.listDeletionCandidates(now, DEFAULT_BATCH);
    return rows.map(toCandidate);
  }

  async function evaluateCandidate(
    candidate: DeletionCandidate,
    now: Date,
  ): Promise<RetentionDecision> {
    const policy = getMediaRetentionPolicy();
    const fresh = await repo.getUpload(candidate.uploadId);
    if (!fresh) {
      return {
        eligible: false,
        defer: false,
        maximumRetentionReached: false,
        reason: "already_deleted",
        expiresAt: candidate.expiresAt,
        absoluteDeleteAt: candidate.absoluteDeleteAt,
      };
    }
    const lease = await repo.getActiveLease(candidate.uploadId, now);
    return evaluateRetention({
      now,
      createdAt: new Date(fresh.meta.createdAt),
      expiresAt: new Date(fresh.meta.expiresAt),
      absoluteDeleteAt: new Date(fresh.meta.absoluteDeleteAt),
      uploadStatus: fresh.meta.uploadStatus,
      hasActiveLease: Boolean(lease),
      alreadyDeleted: fresh.meta.uploadStatus === "deleted" || Boolean(fresh.meta.deletedAt),
      jobTerminalStatus: fresh.jobTerminalStatus,
      policy,
    });
  }

  async function deleteCandidate(
    candidate: DeletionCandidate,
    now: Date = new Date(),
  ): Promise<DeletionResult> {
    const workerId = `cleanup-${randomUUID()}`;
    const locked = await repo.tryAcquireCleanupLock(
      candidate.uploadId,
      workerId,
      now,
      LOCK_TTL_MS,
    );
    if (!locked) {
      return {
        uploadId: candidate.uploadId,
        ok: false,
        alreadyAbsent: false,
        status: "deferred",
        attemptCount: candidate.deletionAttemptCount,
        reportRetained: Boolean(candidate.reportId),
      };
    }

    try {
      const decision = await evaluateCandidate(candidate, now);
      if (decision.defer) {
        console.log(
          `[chelcoach-retention] defer upload=${candidate.uploadId} reason=${decision.reason}`,
        );
        return {
          uploadId: candidate.uploadId,
          ok: true,
          alreadyAbsent: false,
          status: "deferred",
          attemptCount: candidate.deletionAttemptCount,
          reportRetained: Boolean(candidate.reportId),
        };
      }
      if (!decision.eligible) {
        return {
          uploadId: candidate.uploadId,
          ok: true,
          alreadyAbsent: false,
          status: "skipped",
          attemptCount: candidate.deletionAttemptCount,
          reportRetained: Boolean(candidate.reportId),
        };
      }

      if (decision.maximumRetentionReached) {
        await repo.markJobFailedForRetention(candidate.uploadId, "RETENTION_LIMIT_REACHED");
        await repo.updateUploadStatus(candidate.uploadId, "expired", {
          lastDeletionErrorCode: "RETENTION_LIMIT_REACHED",
        });
        console.log(
          `[chelcoach-retention] max retention reached upload=${candidate.uploadId} — forcing media delete`,
        );
      }

      await repo.updateUploadStatus(candidate.uploadId, "deletion_pending");

      const fresh = await repo.getUpload(candidate.uploadId);
      const keys = [
        ...(fresh?.meta.storageObjectKey ? [fresh.meta.storageObjectKey] : []),
        ...(fresh?.derivedObjectKeys ?? candidate.derivedObjectKeys),
      ].filter(Boolean);

      let alreadyAbsent = false;
      try {
        for (const key of keys) {
          const result = await storage.delete(key);
          if (result.alreadyAbsent) alreadyAbsent = true;
        }
      } catch {
        const attempts = candidate.deletionAttemptCount + 1;
        await repo.updateUploadStatus(candidate.uploadId, "delete_failed", {
          deletionAttemptCount: attempts,
          lastDeletionErrorCode: "MEDIA_DELETION_FAILED",
        });
        console.error(
          `[chelcoach-retention] delete_failed upload=${candidate.uploadId} attempts=${attempts}`,
        );
        return {
          uploadId: candidate.uploadId,
          ok: false,
          alreadyAbsent: false,
          status: "delete_failed",
          errorCode: "MEDIA_DELETION_FAILED",
          attemptCount: attempts,
          reportRetained: Boolean(candidate.reportId),
        };
      }

      const deletedAt = now.toISOString();
      await repo.updateUploadStatus(candidate.uploadId, "deleted", {
        deletedAt,
        deletionAttemptCount: candidate.deletionAttemptCount,
        lastDeletionErrorCode: undefined,
      });
      await repo.clearStorageRefs(candidate.uploadId);

      let reportRetained = false;
      if (candidate.reportId) {
        const report = await repo.getReport(candidate.reportId);
        reportRetained = Boolean(report);
      }

      console.log(
        `[chelcoach-retention] deleted upload=${candidate.uploadId} bytes=${candidate.byteSize} duration=${candidate.durationSec ?? "?"} alreadyAbsent=${alreadyAbsent} reportRetained=${reportRetained}`,
      );

      return {
        uploadId: candidate.uploadId,
        ok: true,
        alreadyAbsent,
        status: "deleted",
        attemptCount: candidate.deletionAttemptCount,
        reportRetained,
      };
    } finally {
      await repo.releaseCleanupLock(candidate.uploadId, workerId);
    }
  }

  async function runCleanupBatch(options: CleanupBatchOptions = {}): Promise<CleanupBatchResult> {
    if (batchRunning) {
      return {
        examined: 0,
        deleted: 0,
        deferred: 0,
        failed: 0,
        skipped: 0,
        forcedExpiredJobs: 0,
        results: [],
      };
    }
    batchRunning = true;
    const now = options.now ?? new Date();
    const limit = options.limit ?? DEFAULT_BATCH;
    const results: DeletionResult[] = [];
    let deleted = 0;
    let deferred = 0;
    let failed = 0;
    let skipped = 0;
    let forcedExpiredJobs = 0;

    try {
      const candidates = (await findDeletionCandidates(now)).slice(0, limit);
      for (const candidate of candidates) {
        const decision = await evaluateCandidate(candidate, now);
        if (decision.maximumRetentionReached) forcedExpiredJobs += 1;
        const result = await deleteCandidate(candidate, now);
        results.push(result);
        if (result.status === "deleted") deleted += 1;
        else if (result.status === "deferred") deferred += 1;
        else if (result.status === "delete_failed") failed += 1;
        else skipped += 1;
      }
      console.log(
        `[chelcoach-retention] batch examined=${candidates.length} deleted=${deleted} deferred=${deferred} failed=${failed} skipped=${skipped}`,
      );
      return {
        examined: candidates.length,
        deleted,
        deferred,
        failed,
        skipped,
        forcedExpiredJobs,
        results,
      };
    } finally {
      batchRunning = false;
    }
  }

  return {
    findDeletionCandidates,
    evaluateCandidate,
    deleteCandidate,
    runCleanupBatch,
  };
}
