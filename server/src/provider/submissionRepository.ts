/**
 * Minimal durable submission records for idempotency (Step 4) + status sync (Step 5).
 * Full job lifecycle persistence remains Step 6.
 */
import { randomUUID } from "node:crypto";
import type { AnalysisProvider, ScottyJobStatus } from "../scottyContract";

export interface AnalysisSubmissionRecord {
  applicationRequestId: string;
  uploadId: string;
  ownerId: string;
  provider: AnalysisProvider;
  idempotencyKey: string;
  externalJobId?: string;
  requestFingerprint: string;
  acceptedAt?: string;
  lastKnownStatus: ScottyJobStatus;
  /** Last known monotonic lifecycle sequence from provider. */
  lastSequenceNumber?: number;
  userActionRequired?: boolean;
  reportReady?: boolean;
  confirmationRequired?: boolean;
  cancelledAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface AnalysisSubmissionRepository {
  create(rec: AnalysisSubmissionRecord): Promise<AnalysisSubmissionRecord>;
  getByIdempotencyKey(key: string): Promise<AnalysisSubmissionRecord | undefined>;
  getByRequestId(id: string): Promise<AnalysisSubmissionRecord | undefined>;
  getByExternalJobId(externalJobId: string): Promise<AnalysisSubmissionRecord | undefined>;
  update(
    applicationRequestId: string,
    patch: Partial<AnalysisSubmissionRecord>,
  ): Promise<AnalysisSubmissionRecord>;
}

export class InMemoryAnalysisSubmissionRepository implements AnalysisSubmissionRepository {
  private byId = new Map<string, AnalysisSubmissionRecord>();
  private byKey = new Map<string, string>();
  private byExternal = new Map<string, string>();

  async create(rec: AnalysisSubmissionRecord): Promise<AnalysisSubmissionRecord> {
    const existingKey = this.byKey.get(rec.idempotencyKey);
    if (existingKey) {
      const existing = this.byId.get(existingKey);
      if (existing) return structuredClone(existing);
    }
    const copy = structuredClone(rec);
    this.byId.set(copy.applicationRequestId, copy);
    this.byKey.set(copy.idempotencyKey, copy.applicationRequestId);
    if (copy.externalJobId) this.byExternal.set(copy.externalJobId, copy.applicationRequestId);
    return structuredClone(copy);
  }

  async getByIdempotencyKey(key: string): Promise<AnalysisSubmissionRecord | undefined> {
    const id = this.byKey.get(key);
    return id ? this.getByRequestId(id) : undefined;
  }

  async getByRequestId(id: string): Promise<AnalysisSubmissionRecord | undefined> {
    const row = this.byId.get(id);
    return row ? structuredClone(row) : undefined;
  }

  async getByExternalJobId(externalJobId: string): Promise<AnalysisSubmissionRecord | undefined> {
    const id = this.byExternal.get(externalJobId);
    return id ? this.getByRequestId(id) : undefined;
  }

  async update(
    applicationRequestId: string,
    patch: Partial<AnalysisSubmissionRecord>,
  ): Promise<AnalysisSubmissionRecord> {
    const row = this.byId.get(applicationRequestId);
    if (!row) throw new Error("SUBMISSION_NOT_FOUND");
    if (row.externalJobId) this.byExternal.delete(row.externalJobId);
    Object.assign(row, patch, { updatedAt: new Date().toISOString() });
    if (row.externalJobId) this.byExternal.set(row.externalJobId, row.applicationRequestId);
    return structuredClone(row);
  }

  clear(): void {
    this.byId.clear();
    this.byKey.clear();
    this.byExternal.clear();
  }
}

let repo: AnalysisSubmissionRepository = new InMemoryAnalysisSubmissionRepository();

export function getAnalysisSubmissionRepository(): AnalysisSubmissionRepository {
  return repo;
}

export function setAnalysisSubmissionRepositoryForTests(
  next: AnalysisSubmissionRepository,
): void {
  repo = next;
}

export function resetAnalysisSubmissionRepositoryForTests(): void {
  repo = new InMemoryAnalysisSubmissionRepository();
}

export function newApplicationRequestId(): string {
  return randomUUID();
}
