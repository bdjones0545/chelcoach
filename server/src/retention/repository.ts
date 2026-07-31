/**
 * Durable-facing retention repository.
 * In-memory implementation for Step 1 / CI; Postgres-backed later.
 */
import type {
  ProcessingLease,
  RawUploadMetadata,
  ScottyReport,
  UploadStatus,
} from "../scottyContract";

export interface RetentionUploadRecord {
  meta: RawUploadMetadata;
  /** Derived frame / temp object keys (never logged as content). */
  derivedObjectKeys: string[];
  jobTerminalStatus: "completed" | "failed" | "cancelled" | "active" | "none";
  /** When absolute retention forces failure. */
  forcedFailureCode?: string;
  /** Associated report — retained after media deletion. */
  reportId?: string;
}

export interface RetentionRepository {
  listDeletionCandidates(now: Date, limit: number): Promise<RetentionUploadRecord[]>;
  getUpload(uploadId: string): Promise<RetentionUploadRecord | undefined>;
  getActiveLease(uploadId: string, now: Date): Promise<ProcessingLease | undefined>;
  updateUploadStatus(
    uploadId: string,
    status: UploadStatus,
    patch?: Partial<RawUploadMetadata>,
  ): Promise<void>;
  clearStorageRefs(uploadId: string): Promise<void>;
  getReport(reportId: string): Promise<ScottyReport | undefined>;
  markJobFailedForRetention(uploadId: string, code: string): Promise<void>;
  tryAcquireCleanupLock(uploadId: string, owner: string, now: Date, ttlMs: number): Promise<boolean>;
  releaseCleanupLock(uploadId: string, owner: string): Promise<void>;
}

export class InMemoryRetentionRepository implements RetentionRepository {
  private uploads = new Map<string, RetentionUploadRecord>();
  private leases = new Map<string, ProcessingLease>();
  private reports = new Map<string, ScottyReport>();
  private locks = new Map<string, { owner: string; expiresAt: number }>();

  seedUpload(record: RetentionUploadRecord): void {
    this.uploads.set(record.meta.uploadId, structuredClone(record));
  }

  seedLease(lease: ProcessingLease): void {
    this.leases.set(lease.leaseId, structuredClone(lease));
  }

  seedReport(report: ScottyReport): void {
    this.reports.set(report.reportId, structuredClone(report));
  }

  async listDeletionCandidates(now: Date, limit: number): Promise<RetentionUploadRecord[]> {
    const out: RetentionUploadRecord[] = [];
    for (const rec of this.uploads.values()) {
      if (rec.meta.uploadStatus === "deleted") continue;
      const expired = now.getTime() >= new Date(rec.meta.expiresAt).getTime();
      const maxed = now.getTime() >= new Date(rec.meta.absoluteDeleteAt).getTime();
      const failedRetry = rec.meta.uploadStatus === "delete_failed";
      if (expired || maxed || failedRetry || rec.meta.earlyDeletionRequestedAt) {
        out.push(structuredClone(rec));
      }
      if (out.length >= limit) break;
    }
    return out;
  }

  async getUpload(uploadId: string): Promise<RetentionUploadRecord | undefined> {
    const rec = this.uploads.get(uploadId);
    return rec ? structuredClone(rec) : undefined;
  }

  async getActiveLease(uploadId: string, now: Date): Promise<ProcessingLease | undefined> {
    for (const lease of this.leases.values()) {
      if (lease.uploadId !== uploadId) continue;
      if (lease.status !== "active") continue;
      if (lease.releasedAt) continue;
      if (now.getTime() >= new Date(lease.expiresAt).getTime()) continue;
      return structuredClone(lease);
    }
    return undefined;
  }

  async updateUploadStatus(
    uploadId: string,
    status: UploadStatus,
    patch?: Partial<RawUploadMetadata>,
  ): Promise<void> {
    const rec = this.uploads.get(uploadId);
    if (!rec) return;
    rec.meta.uploadStatus = status;
    if (patch) Object.assign(rec.meta, patch);
  }

  async clearStorageRefs(uploadId: string): Promise<void> {
    const rec = this.uploads.get(uploadId);
    if (!rec) return;
    rec.meta.storageObjectKey = "";
    rec.derivedObjectKeys = [];
  }

  async getReport(reportId: string): Promise<ScottyReport | undefined> {
    const r = this.reports.get(reportId);
    return r ? structuredClone(r) : undefined;
  }

  async markJobFailedForRetention(uploadId: string, code: string): Promise<void> {
    const rec = this.uploads.get(uploadId);
    if (!rec) return;
    if (rec.jobTerminalStatus === "active" || rec.jobTerminalStatus === "none") {
      rec.jobTerminalStatus = "failed";
      rec.forcedFailureCode = code;
    }
  }

  async tryAcquireCleanupLock(
    uploadId: string,
    owner: string,
    now: Date,
    ttlMs: number,
  ): Promise<boolean> {
    const existing = this.locks.get(uploadId);
    if (existing && existing.expiresAt > now.getTime() && existing.owner !== owner) {
      return false;
    }
    this.locks.set(uploadId, { owner, expiresAt: now.getTime() + ttlMs });
    return true;
  }

  async releaseCleanupLock(uploadId: string, owner: string): Promise<void> {
    const existing = this.locks.get(uploadId);
    if (existing?.owner === owner) this.locks.delete(uploadId);
  }
}

let retentionRepo: RetentionRepository = new InMemoryRetentionRepository();

export function getRetentionRepository(): RetentionRepository {
  return retentionRepo;
}

export function setRetentionRepositoryForTests(next: RetentionRepository): void {
  retentionRepo = next;
}

export function resetRetentionRepositoryForTests(): void {
  retentionRepo = new InMemoryRetentionRepository();
}
