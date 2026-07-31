/**
 * Choose in-memory vs Drizzle repositories based on DATABASE_URL.
 * CI and local demos default to memory; production with Postgres uses Drizzle.
 */
import { isDbConfigured } from "./db/client";
import {
  DrizzleAnalysisJobRepository,
} from "./provider/jobs/drizzleJobRepository";
import {
  getAnalysisJobRepository,
  InMemoryAnalysisJobRepository,
  setAnalysisJobRepositoryForTests,
} from "./provider/jobs/jobRepository";
import { detectRestartRecoveryCandidates } from "./provider/jobs/reconciliationService";
import { DrizzleProfileRepository } from "./profile/drizzleRepository";
import {
  getProfileRepository,
  InMemoryProfileRepository,
  setProfileRepositoryForTests,
} from "./profile/repository";
import { DrizzleSimulatorJobRepository } from "./provider/simulator/drizzleRepository";
import {
  InMemorySimulatorJobRepository,
  setSimulatorJobRepositoryForTests,
} from "./provider/simulator/repository";
import { DrizzleUploadRepository } from "./uploads/drizzleRepository";
import {
  getUploadRepository,
  InMemoryUploadRepository,
  setUploadRepositoryForTests,
} from "./uploads/repository";

let wired = false;

export function wirePersistence(): void {
  if (wired) return;
  wired = true;
  // CI / unit tests always use memory unless explicitly opted in.
  if (process.env.CHELCOACH_FORCE_MEMORY_REPOS === "1" || process.env.NODE_ENV === "test") {
    return;
  }
  if (!isDbConfigured()) {
    return;
  }
  setUploadRepositoryForTests(new DrizzleUploadRepository());
  setProfileRepositoryForTests(new DrizzleProfileRepository());
  setAnalysisJobRepositoryForTests(new DrizzleAnalysisJobRepository());
  setSimulatorJobRepositoryForTests(new DrizzleSimulatorJobRepository());
  console.log(
    "[chelcoach] persistence=drizzle (profiles + uploads + analysis_jobs + simulator_jobs)",
  );

  // Non-blocking restart recovery signal — do not process all jobs before serving traffic.
  void detectRestartRecoveryCandidates(5).catch(() => undefined);
}

export function resetPersistenceForTests(): void {
  wired = false;
  setUploadRepositoryForTests(new InMemoryUploadRepository());
  setProfileRepositoryForTests(new InMemoryProfileRepository());
  setAnalysisJobRepositoryForTests(new InMemoryAnalysisJobRepository());
  setSimulatorJobRepositoryForTests(new InMemorySimulatorJobRepository());
}

export function persistenceBackend(): "memory" | "drizzle" {
  void getUploadRepository;
  void getProfileRepository;
  void getAnalysisJobRepository;
  return isDbConfigured() && wired ? "drizzle" : "memory";
}
