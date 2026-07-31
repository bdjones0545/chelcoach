import { randomUUID } from "node:crypto";
import type {
  ConfirmationFrameRecord,
  PlayerCandidateRecord,
  PlayerConfirmationRecord,
  PlayerIdentificationRecord,
  ProcessingLeaseRecord,
} from "./types";

export interface IdentificationRepository {
  createIdentification(rec: PlayerIdentificationRecord): Promise<PlayerIdentificationRecord>;
  getIdentification(id: string): Promise<PlayerIdentificationRecord | undefined>;
  getByUploadId(uploadId: string): Promise<PlayerIdentificationRecord | undefined>;
  updateIdentification(
    id: string,
    patch: Partial<PlayerIdentificationRecord>,
  ): Promise<PlayerIdentificationRecord>;

  createFrame(rec: ConfirmationFrameRecord): Promise<ConfirmationFrameRecord>;
  getFrame(frameId: string): Promise<ConfirmationFrameRecord | undefined>;
  listFrames(identificationId: string): Promise<ConfirmationFrameRecord[]>;
  markFrameDeleted(frameId: string): Promise<void>;

  createCandidate(rec: PlayerCandidateRecord): Promise<PlayerCandidateRecord>;
  getCandidate(candidateId: string): Promise<PlayerCandidateRecord | undefined>;
  listCandidates(identificationId: string): Promise<PlayerCandidateRecord[]>;
  replaceCandidates(
    identificationId: string,
    candidates: PlayerCandidateRecord[],
  ): Promise<PlayerCandidateRecord[]>;

  createConfirmation(rec: PlayerConfirmationRecord): Promise<PlayerConfirmationRecord>;
  getConfirmation(id: string): Promise<PlayerConfirmationRecord | undefined>;
  getConfirmationByIdentification(
    identificationId: string,
  ): Promise<PlayerConfirmationRecord | undefined>;

  acquireLease(rec: ProcessingLeaseRecord): Promise<ProcessingLeaseRecord>;
  getActiveLease(uploadId: string): Promise<ProcessingLeaseRecord | undefined>;
  releaseLease(leaseId: string): Promise<void>;
}

export class InMemoryIdentificationRepository implements IdentificationRepository {
  private ids = new Map<string, PlayerIdentificationRecord>();
  private byUpload = new Map<string, string>();
  private frames = new Map<string, ConfirmationFrameRecord>();
  private candidates = new Map<string, PlayerCandidateRecord>();
  private confirmations = new Map<string, PlayerConfirmationRecord>();
  private leases = new Map<string, ProcessingLeaseRecord>();

  async createIdentification(rec: PlayerIdentificationRecord): Promise<PlayerIdentificationRecord> {
    const existing = this.byUpload.get(rec.uploadId);
    if (existing) {
      const cur = this.ids.get(existing);
      if (cur) return structuredClone(cur);
    }
    const copy = structuredClone(rec);
    this.ids.set(copy.identificationId, copy);
    this.byUpload.set(copy.uploadId, copy.identificationId);
    return structuredClone(copy);
  }

  async getIdentification(id: string): Promise<PlayerIdentificationRecord | undefined> {
    const row = this.ids.get(id);
    return row ? structuredClone(row) : undefined;
  }

  async getByUploadId(uploadId: string): Promise<PlayerIdentificationRecord | undefined> {
    const id = this.byUpload.get(uploadId);
    return id ? this.getIdentification(id) : undefined;
  }

  async updateIdentification(
    id: string,
    patch: Partial<PlayerIdentificationRecord>,
  ): Promise<PlayerIdentificationRecord> {
    const row = this.ids.get(id);
    if (!row) throw new Error("IDENTIFICATION_NOT_FOUND");
    Object.assign(row, patch, { updatedAt: new Date().toISOString() });
    return structuredClone(row);
  }

  async createFrame(rec: ConfirmationFrameRecord): Promise<ConfirmationFrameRecord> {
    const copy = structuredClone(rec);
    this.frames.set(copy.frameId, copy);
    return structuredClone(copy);
  }

  async getFrame(frameId: string): Promise<ConfirmationFrameRecord | undefined> {
    const row = this.frames.get(frameId);
    return row ? structuredClone(row) : undefined;
  }

  async listFrames(identificationId: string): Promise<ConfirmationFrameRecord[]> {
    return [...this.frames.values()]
      .filter((f) => f.identificationId === identificationId && !f.deletedAt)
      .map((f) => structuredClone(f));
  }

  async markFrameDeleted(frameId: string): Promise<void> {
    const row = this.frames.get(frameId);
    if (row) row.deletedAt = new Date().toISOString();
  }

  async createCandidate(rec: PlayerCandidateRecord): Promise<PlayerCandidateRecord> {
    const copy = structuredClone(rec);
    this.candidates.set(copy.candidateId, copy);
    return structuredClone(copy);
  }

  async getCandidate(candidateId: string): Promise<PlayerCandidateRecord | undefined> {
    const row = this.candidates.get(candidateId);
    return row ? structuredClone(row) : undefined;
  }

  async listCandidates(identificationId: string): Promise<PlayerCandidateRecord[]> {
    return [...this.candidates.values()]
      .filter((c) => c.identificationId === identificationId)
      .map((c) => structuredClone(c));
  }

  async replaceCandidates(
    identificationId: string,
    candidates: PlayerCandidateRecord[],
  ): Promise<PlayerCandidateRecord[]> {
    for (const [id, c] of this.candidates) {
      if (c.identificationId === identificationId) this.candidates.delete(id);
    }
    for (const c of candidates) this.candidates.set(c.candidateId, structuredClone(c));
    return candidates.map((c) => structuredClone(c));
  }

  async createConfirmation(rec: PlayerConfirmationRecord): Promise<PlayerConfirmationRecord> {
    const copy = structuredClone(rec);
    this.confirmations.set(copy.confirmationId, copy);
    return structuredClone(copy);
  }

  async getConfirmation(id: string): Promise<PlayerConfirmationRecord | undefined> {
    const row = this.confirmations.get(id);
    return row ? structuredClone(row) : undefined;
  }

  async getConfirmationByIdentification(
    identificationId: string,
  ): Promise<PlayerConfirmationRecord | undefined> {
    for (const c of this.confirmations.values()) {
      if (c.identificationId === identificationId) return structuredClone(c);
    }
    return undefined;
  }

  async acquireLease(rec: ProcessingLeaseRecord): Promise<ProcessingLeaseRecord> {
    const active = await this.getActiveLease(rec.uploadId);
    if (active) {
      throw Object.assign(new Error("PROCESSING_LEASE_CONFLICT"), {
        code: "PROCESSING_LEASE_CONFLICT",
      });
    }
    const copy = structuredClone(rec);
    this.leases.set(copy.leaseId, copy);
    return structuredClone(copy);
  }

  async getActiveLease(uploadId: string): Promise<ProcessingLeaseRecord | undefined> {
    const now = Date.now();
    for (const lease of this.leases.values()) {
      if (lease.uploadId !== uploadId) continue;
      if (lease.status !== "active") continue;
      if (lease.releasedAt) continue;
      if (new Date(lease.expiresAt).getTime() <= now) {
        lease.status = "expired";
        continue;
      }
      return structuredClone(lease);
    }
    return undefined;
  }

  async releaseLease(leaseId: string): Promise<void> {
    const lease = this.leases.get(leaseId);
    if (!lease) return;
    lease.status = "released";
    lease.releasedAt = new Date().toISOString();
  }

  clear(): void {
    this.ids.clear();
    this.byUpload.clear();
    this.frames.clear();
    this.candidates.clear();
    this.confirmations.clear();
    this.leases.clear();
  }

  deleteByUploadId(uploadId: string): boolean {
    const identificationId = this.byUpload.get(uploadId);
    if (!identificationId) return false;
    this.byUpload.delete(uploadId);
    this.ids.delete(identificationId);
    for (const [id, frame] of this.frames) {
      if (frame.identificationId === identificationId) this.frames.delete(id);
    }
    for (const [id, candidate] of this.candidates) {
      if (candidate.identificationId === identificationId) this.candidates.delete(id);
    }
    for (const [id, confirmation] of this.confirmations) {
      if (confirmation.identificationId === identificationId) this.confirmations.delete(id);
    }
    for (const [id, lease] of this.leases) {
      if (lease.uploadId === uploadId) this.leases.delete(id);
    }
    return true;
  }
}

let repo: IdentificationRepository = new InMemoryIdentificationRepository();

export function getIdentificationRepository(): IdentificationRepository {
  return repo;
}

export function setIdentificationRepositoryForTests(next: IdentificationRepository): void {
  repo = next;
}

export function resetIdentificationRepositoryForTests(): void {
  repo = new InMemoryIdentificationRepository();
}

/** E2E helper — drop identification state for one upload. */
export async function deleteIdentificationForUpload(uploadId: string): Promise<boolean> {
  if (repo instanceof InMemoryIdentificationRepository) {
    return repo.deleteByUploadId(uploadId);
  }
  const maybe = repo as unknown as { deleteByUploadId?: (id: string) => Promise<boolean> };
  if (typeof maybe.deleteByUploadId === "function") {
    return maybe.deleteByUploadId(uploadId);
  }
  return false;
}

export function newId(): string {
  return randomUUID();
}
