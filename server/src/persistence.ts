/**
 * Choose in-memory vs Drizzle repositories based on DATABASE_URL.
 * CI and local demos default to memory; production with Postgres uses Drizzle.
 * When DATABASE_URL is configured outside test mode, production must not silently use memory.
 */
import { isDbConfigured } from "./db/client";
import { DrizzleIdentificationRepository } from "./identification/drizzleRepository";
import {
  InMemoryIdentificationRepository,
  setIdentificationRepositoryForTests,
} from "./identification/repository";
import {
  DrizzleAnalysisJobRepository,
} from "./provider/jobs/drizzleJobRepository";
import {
  InMemoryAnalysisJobRepository,
  setAnalysisJobRepositoryForTests,
} from "./provider/jobs/jobRepository";
import { detectRestartRecoveryCandidates } from "./provider/jobs/reconciliationService";
import { DrizzleProfileRepository } from "./profile/drizzleRepository";
import {
  InMemoryProfileRepository,
  setProfileRepositoryForTests,
} from "./profile/repository";
import { DrizzleSimulatorJobRepository } from "./provider/simulator/drizzleRepository";
import {
  InMemorySimulatorJobRepository,
  setSimulatorJobRepositoryForTests,
} from "./provider/simulator/repository";
import { DrizzleRetentionRepository } from "./retention/drizzleRepository";
import {
  InMemoryRetentionRepository,
  setRetentionRepositoryForTests,
} from "./retention/repository";
import { DrizzleUploadRepository } from "./uploads/drizzleRepository";
import {
  InMemoryUploadRepository,
  setUploadRepositoryForTests,
} from "./uploads/repository";

let wired = false;
let backend: "memory" | "drizzle" = "memory";

export function wirePersistence(): void {
  if (wired) return;
  wired = true;
  // CI / unit tests always use memory unless explicitly opted in.
  if (process.env.CHELCOACH_FORCE_MEMORY_REPOS === "1" || process.env.NODE_ENV === "test") {
    backend = "memory";
    return;
  }
  if (!isDbConfigured()) {
    backend = "memory";
    if (process.env.NODE_ENV === "production") {
      console.warn(
        "[chelcoach] persistence=memory in production — analysis submission will remain disabled until DATABASE_URL is configured.",
      );
    }
    return;
  }
  setUploadRepositoryForTests(new DrizzleUploadRepository());
  setProfileRepositoryForTests(new DrizzleProfileRepository());
  setAnalysisJobRepositoryForTests(new DrizzleAnalysisJobRepository());
  setSimulatorJobRepositoryForTests(new DrizzleSimulatorJobRepository());
  setIdentificationRepositoryForTests(new DrizzleIdentificationRepository());
  setRetentionRepositoryForTests(new DrizzleRetentionRepository());
  backend = "drizzle";
  console.log(
    "[chelcoach] persistence=drizzle (profiles + uploads + identification + retention + analysis_jobs + simulator_jobs)",
  );

  // Non-blocking restart recovery signal — do not process all jobs before serving traffic.
  void detectRestartRecoveryCandidates(5).catch(() => undefined);
}

export function resetPersistenceForTests(): void {
  wired = false;
  backend = "memory";
  setUploadRepositoryForTests(new InMemoryUploadRepository());
  setProfileRepositoryForTests(new InMemoryProfileRepository());
  setAnalysisJobRepositoryForTests(new InMemoryAnalysisJobRepository());
  setSimulatorJobRepositoryForTests(new InMemorySimulatorJobRepository());
  setIdentificationRepositoryForTests(new InMemoryIdentificationRepository());
  setRetentionRepositoryForTests(new InMemoryRetentionRepository());
}

export function persistenceBackend(): "memory" | "drizzle" {
  return backend;
}

/** True when durable identification/retention are active (not memory). */
export function isDurablePersistenceActive(): boolean {
  return backend === "drizzle";
}
