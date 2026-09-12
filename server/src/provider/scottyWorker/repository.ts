import type { ScottyWorkerJob, ScottyWorkerJobPatch } from "./types";
import { ACTIVE_STATUSES, RUNNABLE_STATUSES } from "./types";

export interface ScottyWorkerJobRepository {
  /** Idempotent on idempotencyKey — returns the existing row when present. */
  create(job: ScottyWorkerJob): Promise<ScottyWorkerJob>;
  getByExternalJobId(externalJobId: string): Promise<ScottyWorkerJob | null>;
  getByIdempotencyKey(idempotencyKey: string): Promise<ScottyWorkerJob | null>;
  update(externalJobId: string, patch: ScottyWorkerJobPatch): Promise<ScottyWorkerJob>;
  /**
   * Atomically claim the oldest runnable job: runnable status, not claimed (or claim expired),
   * and not scheduled for a later attempt. Returns null when nothing is runnable.
   */
  claimNext(input: { workerId: string; now: Date; leaseMs: number }): Promise<ScottyWorkerJob | null>;
  listActive(): Promise<ScottyWorkerJob[]>;
  clear(): void;
}

export function isClaimable(job: ScottyWorkerJob, now: Date): boolean {
  if (!RUNNABLE_STATUSES.has(job.status)) return false;
  if (job.cancelledAt) return false;
  if (job.nextAttemptAt && new Date(job.nextAttemptAt).getTime() > now.getTime()) return false;
  if (job.claimExpiresAt && new Date(job.claimExpiresAt).getTime() > now.getTime()) return false;
  return true;
}

export class InMemoryScottyWorkerJobRepository implements ScottyWorkerJobRepository {
  private byId = new Map<string, ScottyWorkerJob>();
  private byKey = new Map<string, string>();

  async create(job: ScottyWorkerJob): Promise<ScottyWorkerJob> {
    const existingId = this.byKey.get(job.idempotencyKey);
    if (existingId) return structuredClone(this.byId.get(existingId)!);
    const copy = structuredClone(job);
    this.byId.set(copy.externalJobId, copy);
    this.byKey.set(copy.idempotencyKey, copy.externalJobId);
    return structuredClone(copy);
  }

  async getByExternalJobId(externalJobId: string): Promise<ScottyWorkerJob | null> {
    const row = this.byId.get(externalJobId);
    return row ? structuredClone(row) : null;
  }

  async getByIdempotencyKey(idempotencyKey: string): Promise<ScottyWorkerJob | null> {
    const id = this.byKey.get(idempotencyKey);
    return id ? this.getByExternalJobId(id) : null;
  }

  async update(externalJobId: string, patch: ScottyWorkerJobPatch): Promise<ScottyWorkerJob> {
    const current = this.byId.get(externalJobId);
    if (!current) throw new Error("SCOTTY_WORKER_JOB_NOT_FOUND");
    const next = { ...current, ...structuredClone(patch), updatedAt: new Date().toISOString() };
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) delete (next as Record<string, unknown>)[k];
    }
    this.byId.set(externalJobId, next);
    return structuredClone(next);
  }

  async claimNext(input: { workerId: string; now: Date; leaseMs: number }): Promise<ScottyWorkerJob | null> {
    const candidates = [...this.byId.values()]
      .filter((j) => isClaimable(j, input.now))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const job = candidates[0];
    if (!job) return null;
    return this.update(job.externalJobId, {
      workerId: input.workerId,
      claimExpiresAt: new Date(input.now.getTime() + input.leaseMs).toISOString(),
      attemptCount: job.attemptCount + 1,
      startedAt: job.startedAt ?? input.now.toISOString(),
    });
  }

  async listActive(): Promise<ScottyWorkerJob[]> {
    return [...this.byId.values()].filter((j) => ACTIVE_STATUSES.has(j.status)).map((j) => structuredClone(j));
  }

  clear(): void {
    this.byId.clear();
    this.byKey.clear();
  }
}

let repo: ScottyWorkerJobRepository = new InMemoryScottyWorkerJobRepository();

export function getScottyWorkerJobRepository(): ScottyWorkerJobRepository {
  return repo;
}

export function setScottyWorkerJobRepositoryForTests(next: ScottyWorkerJobRepository): void {
  repo = next;
}

export function resetScottyWorkerJobRepositoryForTests(): void {
  repo = new InMemoryScottyWorkerJobRepository();
}
