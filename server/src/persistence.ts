/**
 * Choose in-memory vs Drizzle repositories based on DATABASE_URL.
 * CI and local demos default to memory; production with Postgres uses Drizzle.
 */
import { isDbConfigured } from "./db/client";
import { DrizzleProfileRepository } from "./profile/drizzleRepository";
import {
  getProfileRepository,
  InMemoryProfileRepository,
  setProfileRepositoryForTests,
} from "./profile/repository";
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
  console.log("[chelcoach] persistence=drizzle (gameplay_profiles + media_uploads)");
}

export function resetPersistenceForTests(): void {
  wired = false;
  setUploadRepositoryForTests(new InMemoryUploadRepository());
  setProfileRepositoryForTests(new InMemoryProfileRepository());
}

export function persistenceBackend(): "memory" | "drizzle" {
  void getUploadRepository;
  void getProfileRepository;
  return isDbConfigured() && wired ? "drizzle" : "memory";
}
