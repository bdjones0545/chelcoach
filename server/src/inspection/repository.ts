/**
 * Media inspection job repository — memory for CI; Drizzle for durable Postgres.
 */
import { randomUUID } from "node:crypto";
import type { CreateInspectionJobInput, MediaInspectionJobRecord } from "./types";
import type { MediaInspectionStatus } from "../scottyContract";

export interface InspectionJobRepository {
  create(input: CreateInspectionJobInput): Promise<MediaInspectionJobRecord>;
  get(jobId: string): Promise<MediaInspectionJobRecord | undefined>;
  getActiveByUpload(uploadId: string): Promise<MediaInspectionJobRecord | undefined>;
  getByUploadAndFingerprint(
    uploadId: string,
    fingerprint: string,
  ): Promise<MediaInspectionJobRecord | undefined>;
  update(
    jobId: string,
    patch: Partial<MediaInspectionJobRecord>,
    expectedVersion?: number,
  ): Promise<MediaInspectionJobRecord>;
  /**
   * Atomically claim the next available job.
   * Implementations must use SKIP LOCKED (or equivalent) when durable.
   */
  claimNext(input: {
    workerId: string;
    now: Date;
    leaseMs: number;
  }): Promise<MediaInspectionJobRecord | null>;
  listByUpload(uploadId: string): Promise<MediaInspectionJobRecord[]>;
  cancelActiveForUpload(uploadId: string, reason: string): Promise<number>;
}

const ACTIVE: ReadonlySet<MediaInspectionStatus> = new Set([
  "queued",
  "claimed",
  "downloading",
  "inspecting",
  "validating",
]);

export class InMemoryInspectionJobRepository implements InspectionJobRepository {
  private rows = new Map<string, MediaInspectionJobRecord>();

  async create(input: CreateInspectionJobInput): Promise<MediaInspectionJobRecord> {
    const existing = await this.getByUploadAndFingerprint(input.uploadId, input.objectFingerprint);
    if (existing && ACTIVE.has(existing.status)) return structuredClone(existing);
    if (existing?.status === "completed") return structuredClone(existing);

    const now = new Date().toISOString();
    const record: MediaInspectionJobRecord = {
      id: randomUUID(),
      uploadId: input.uploadId,
      ownerId: input.ownerId,
      storageProvider: input.storageProvider,
      bucketAlias: input.bucketAlias,
      objectKey: input.objectKey,
      objectFingerprint: input.objectFingerprint,
      contractVersion: "1.0.0",
      status: "queued",
      attemptCount: 0,
      maxAttempts: input.maxAttempts ?? 3,
      nextAttemptAt: now,
      trustedByteSize: input.trustedByteSize,
      trustedMimeType: input.trustedMimeType,
      retryable: true,
      version: 1,
      createdAt: now,
      updatedAt: now,
    };
    this.rows.set(record.id, record);
    return structuredClone(record);
  }

  async get(jobId: string): Promise<MediaInspectionJobRecord | undefined> {
    const row = this.rows.get(jobId);
    return row ? structuredClone(row) : undefined;
  }

  async getActiveByUpload(uploadId: string): Promise<MediaInspectionJobRecord | undefined> {
    for (const row of this.rows.values()) {
      if (row.uploadId === uploadId && ACTIVE.has(row.status)) return structuredClone(row);
    }
    // Prefer latest completed for status display
    let latest: MediaInspectionJobRecord | undefined;
    for (const row of this.rows.values()) {
      if (row.uploadId !== uploadId) continue;
      if (!latest || row.createdAt > latest.createdAt) latest = row;
    }
    return latest ? structuredClone(latest) : undefined;
  }

  async getByUploadAndFingerprint(
    uploadId: string,
    fingerprint: string,
  ): Promise<MediaInspectionJobRecord | undefined> {
    for (const row of this.rows.values()) {
      if (row.uploadId === uploadId && row.objectFingerprint === fingerprint) {
        return structuredClone(row);
      }
    }
    return undefined;
  }

  async update(
    jobId: string,
    patch: Partial<MediaInspectionJobRecord>,
    expectedVersion?: number,
  ): Promise<MediaInspectionJobRecord> {
    const row = this.rows.get(jobId);
    if (!row) throw new Error("INSPECTION_JOB_NOT_FOUND");
    if (expectedVersion !== undefined && row.version !== expectedVersion) {
      throw Object.assign(new Error("VERSION_CONFLICT"), { code: "VERSION_CONFLICT" });
    }
    Object.assign(row, patch, {
      version: row.version + 1,
      updatedAt: new Date().toISOString(),
    });
    return structuredClone(row);
  }

  async claimNext(input: {
    workerId: string;
    now: Date;
    leaseMs: number;
  }): Promise<MediaInspectionJobRecord | null> {
    const nowMs = input.now.getTime();
    const candidates = [...this.rows.values()]
      .filter((row) => {
        if (row.status === "queued") {
          const next = row.nextAttemptAt ? new Date(row.nextAttemptAt).getTime() : 0;
          return next <= nowMs;
        }
        if (
          (row.status === "claimed" ||
            row.status === "downloading" ||
            row.status === "inspecting" ||
            row.status === "validating") &&
          row.claimExpiresAt &&
          new Date(row.claimExpiresAt).getTime() <= nowMs
        ) {
          return true; // stale claim recovery
        }
        return false;
      })
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

    const row = candidates[0];
    if (!row) return null;
    const claimedAt = input.now.toISOString();
    const claimExpiresAt = new Date(nowMs + input.leaseMs).toISOString();
    Object.assign(row, {
      status: "claimed" as const,
      workerId: input.workerId,
      claimedAt,
      claimExpiresAt,
      heartbeatAt: claimedAt,
      startedAt: row.startedAt ?? claimedAt,
      attemptCount: row.attemptCount + 1,
      version: row.version + 1,
      updatedAt: claimedAt,
    });
    return structuredClone(row);
  }

  async listByUpload(uploadId: string): Promise<MediaInspectionJobRecord[]> {
    return [...this.rows.values()]
      .filter((r) => r.uploadId === uploadId)
      .map((r) => structuredClone(r));
  }

  async cancelActiveForUpload(uploadId: string, reason: string): Promise<number> {
    let n = 0;
    for (const row of this.rows.values()) {
      if (row.uploadId !== uploadId || !ACTIVE.has(row.status)) continue;
      Object.assign(row, {
        status: "cancelled" as const,
        errorMessage: reason,
        retryable: false,
        version: row.version + 1,
        updatedAt: new Date().toISOString(),
      });
      n += 1;
    }
    return n;
  }

  clear(): void {
    this.rows.clear();
  }
}

let repo: InspectionJobRepository = new InMemoryInspectionJobRepository();

export function getInspectionJobRepository(): InspectionJobRepository {
  return repo;
}

export function setInspectionJobRepositoryForTests(next: InspectionJobRepository): void {
  repo = next;
}

export function resetInspectionJobRepositoryForTests(): void {
  repo = new InMemoryInspectionJobRepository();
}

export function newInspectionJobId(): string {
  return randomUUID();
}
