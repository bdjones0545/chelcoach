import type { SimulatorJob } from "./types";

export interface SimulatorJobRepository {
  create(job: SimulatorJob): Promise<SimulatorJob>;
  getByExternalJobId(externalJobId: string): Promise<SimulatorJob | null>;
  getByIdempotencyKey(idempotencyKey: string): Promise<SimulatorJob | null>;
  update(job: SimulatorJob): Promise<SimulatorJob>;
  listActive(): Promise<SimulatorJob[]>;
  clear(): void;
}

export class InMemorySimulatorJobRepository implements SimulatorJobRepository {
  private byId = new Map<string, SimulatorJob>();
  private byKey = new Map<string, string>();

  async create(job: SimulatorJob): Promise<SimulatorJob> {
    const existing = this.byKey.get(job.idempotencyKey);
    if (existing) {
      const cur = this.byId.get(existing);
      if (cur) return structuredClone(cur);
    }
    const copy = structuredClone(job);
    this.byId.set(copy.externalJobId, copy);
    this.byKey.set(copy.idempotencyKey, copy.externalJobId);
    return structuredClone(copy);
  }

  async getByExternalJobId(externalJobId: string): Promise<SimulatorJob | null> {
    const row = this.byId.get(externalJobId);
    return row ? structuredClone(row) : null;
  }

  async getByIdempotencyKey(idempotencyKey: string): Promise<SimulatorJob | null> {
    const id = this.byKey.get(idempotencyKey);
    return id ? this.getByExternalJobId(id) : null;
  }

  async update(job: SimulatorJob): Promise<SimulatorJob> {
    if (!this.byId.has(job.externalJobId)) throw new Error("SIMULATOR_JOB_NOT_FOUND");
    const copy = structuredClone(job);
    this.byId.set(copy.externalJobId, copy);
    this.byKey.set(copy.idempotencyKey, copy.externalJobId);
    return structuredClone(copy);
  }

  async listActive(): Promise<SimulatorJob[]> {
    return [...this.byId.values()]
      .filter((j) => !j.terminalStatus)
      .map((j) => structuredClone(j));
  }

  clear(): void {
    this.byId.clear();
    this.byKey.clear();
  }
}

let repo: SimulatorJobRepository = new InMemorySimulatorJobRepository();

export function getSimulatorJobRepository(): SimulatorJobRepository {
  return repo;
}

export function setSimulatorJobRepositoryForTests(next: SimulatorJobRepository): void {
  repo = next;
}

export function resetSimulatorJobRepositoryForTests(): void {
  repo = new InMemorySimulatorJobRepository();
}
