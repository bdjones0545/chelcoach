/**
 * Durable upload repository — in-memory for CI; interface ready for Drizzle.
 */
import { randomUUID } from "node:crypto";
import type {
  ScottyErrorCode,
  UploadGameplayContext,
  UploadStatus,
  TrustedMediaMetadata,
  MediaClassification,
} from "../scottyContract";

export interface MediaUploadRecord {
  uploadId: string;
  ownerId: string;
  storageProvider: string;
  storageObjectKey: string;
  originalFilename: string;
  displayFilename: string;
  mimeType: "video/mp4" | "video/quicktime";
  declaredByteSize: number;
  storedByteSize?: number;
  clientDeclaredDurationSec?: number;
  trustedMedia?: TrustedMediaMetadata;
  mediaClassification?: MediaClassification;
  uploadStatus: UploadStatus;
  context: UploadGameplayContext;
  retentionPolicyVersion: string;
  expiresAt: string;
  absoluteDeleteAt: string;
  pendingExpiresAt: string;
  createdAt: string;
  uploadedAt?: string;
  readyAt?: string;
  deletedAt?: string;
  deletionAttemptCount: number;
  lastDeletionErrorCode?: string;
  earlyDeletionRequestedAt?: string;
  errorCode?: ScottyErrorCode;
  errorMessage?: string;
}

export interface UploadRepository {
  create(record: MediaUploadRecord): Promise<MediaUploadRecord>;
  get(uploadId: string): Promise<MediaUploadRecord | undefined>;
  update(uploadId: string, patch: Partial<MediaUploadRecord>): Promise<MediaUploadRecord>;
  listExpiredPending(now: Date, limit: number): Promise<MediaUploadRecord[]>;
  /** Active transfer or unfinished sessions for quota enforcement. */
  countActiveUploadsForOwner(ownerId: string): Promise<number>;
  /** Pending sessions awaiting transfer start. */
  countPendingUploadsForOwner(ownerId: string): Promise<number>;
}

export class InMemoryUploadRepository implements UploadRepository {
  private rows = new Map<string, MediaUploadRecord>();

  async create(record: MediaUploadRecord): Promise<MediaUploadRecord> {
    const copy = structuredClone(record);
    this.rows.set(copy.uploadId, copy);
    return structuredClone(copy);
  }

  async get(uploadId: string): Promise<MediaUploadRecord | undefined> {
    const row = this.rows.get(uploadId);
    return row ? structuredClone(row) : undefined;
  }

  async update(uploadId: string, patch: Partial<MediaUploadRecord>): Promise<MediaUploadRecord> {
    const row = this.rows.get(uploadId);
    if (!row) throw new Error("UPLOAD_NOT_FOUND");
    Object.assign(row, patch);
    return structuredClone(row);
  }

  async listExpiredPending(now: Date, limit: number): Promise<MediaUploadRecord[]> {
    const out: MediaUploadRecord[] = [];
    for (const row of this.rows.values()) {
      if (row.uploadStatus !== "pending" && row.uploadStatus !== "uploading") continue;
      if (now.getTime() >= new Date(row.pendingExpiresAt).getTime()) {
        out.push(structuredClone(row));
      }
      if (out.length >= limit) break;
    }
    return out;
  }

  async countActiveUploadsForOwner(ownerId: string): Promise<number> {
    let n = 0;
    for (const row of this.rows.values()) {
      if (row.ownerId !== ownerId) continue;
      if (
        row.uploadStatus === "pending" ||
        row.uploadStatus === "uploading" ||
        row.uploadStatus === "uploaded" ||
        row.uploadStatus === "processing"
      ) {
        n += 1;
      }
    }
    return n;
  }

  async countPendingUploadsForOwner(ownerId: string): Promise<number> {
    let n = 0;
    for (const row of this.rows.values()) {
      if (row.ownerId !== ownerId) continue;
      if (row.uploadStatus === "pending" || row.uploadStatus === "uploading") n += 1;
    }
    return n;
  }

  clear(): void {
    this.rows.clear();
  }
}

let repo: UploadRepository = new InMemoryUploadRepository();

export function getUploadRepository(): UploadRepository {
  return repo;
}

export function setUploadRepositoryForTests(next: UploadRepository): void {
  repo = next;
}

export function resetUploadRepositoryForTests(): void {
  repo = new InMemoryUploadRepository();
}

export function newUploadId(): string {
  return randomUUID();
}
