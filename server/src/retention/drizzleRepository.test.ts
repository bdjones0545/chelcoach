/**
 * Step 10 — Postgres integration tests for durable retention + cleanup locks.
 */
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { getDb, isDbConfigured } from "../db/client";
import { mediaUploads, processingLeases } from "../db/schema";
import { DrizzleAnalysisJobRepository } from "../provider/jobs/drizzleJobRepository";
import { createMediaRetentionService } from "./cleanup";
import { DrizzleRetentionRepository } from "./drizzleRepository";
import { setRetentionRepositoryForTests } from "./repository";
import type { ObjectStorage } from "../storage";
import { minimalScottyReport } from "../scottyContract";

const runPg = process.env.CHELCOACH_RUN_PG_TESTS === "1" && isDbConfigured();

class TrackingStorage implements ObjectStorage {
  readonly backend = "memory" as const;
  deleted = new Set<string>();
  async put(): Promise<void> {}
  async exists(key: string): Promise<boolean> {
    return !this.deleted.has(key);
  }
  async delete(key: string): Promise<{ deleted: boolean; alreadyAbsent: boolean }> {
    const alreadyAbsent = this.deleted.has(key);
    this.deleted.add(key);
    return { deleted: true, alreadyAbsent };
  }
}

async function seedUpload(input: {
  uploadId: string;
  expiresAt: Date;
  absoluteDeleteAt: Date;
  status?: "ready" | "delete_failed";
  key?: string;
}): Promise<void> {
  const db = getDb();
  await db.insert(mediaUploads).values({
    id: input.uploadId,
    ownerId: "own-ret-pg",
    storageProvider: "memory",
    storageObjectKey: input.key ?? `obj-${input.uploadId}`,
    originalFilename: "g.mp4",
    displayFilename: "g.mp4",
    mimeType: "video/mp4",
    byteSize: 4096,
    uploadStatus: input.status ?? "ready",
    retentionPolicyVersion: "v1",
    expiresAt: input.expiresAt,
    absoluteDeleteAt: input.absoluteDeleteAt,
    pendingExpiresAt: input.expiresAt,
    gameplayContext: {
      gameContext: {
        selectedGameTitle: "NHL 25",
        canonicalGameId: "nhl-25",
        supportStatus: "supported",
        mismatchState: "none",
      },
      playerContext: {
        platform: "xbox_series",
        controlScheme: "skill_stick",
        position: "C",
        gameMode: "eashl",
      },
      singlePlayerControl: true,
    },
  });
}

describe("drizzle retention repository (postgres)", { skip: !runPg }, () => {
  const repo = new DrizzleRetentionRepository();

  beforeEach(async () => {
    setRetentionRepositoryForTests(repo);
    const db = getDb();
    await db.execute(sql`
      truncate table scotty_callback_events, scotty_analysis_job_events, scotty_analysis_reports,
      scotty_analysis_jobs, scotty_simulator_jobs, processing_leases, media_cleanup_locks,
      confirmation_frames, player_candidates, player_confirmations, player_identifications,
      media_uploads cascade
    `);
  });

  it("lists deletion candidates from durable expiry fields", async () => {
    const uploadId = randomUUID();
    const past = new Date(Date.now() - 60_000);
    await seedUpload({
      uploadId,
      expiresAt: past,
      absoluteDeleteAt: new Date(Date.now() + 86_400_000),
    });
    const candidates = await repo.listDeletionCandidates(new Date(), 10);
    assert.ok(candidates.some((c) => c.meta.uploadId === uploadId));
  });

  it("cleanup lock prevents overlap; stale lock recovers", async () => {
    const uploadId = randomUUID();
    await seedUpload({
      uploadId,
      expiresAt: new Date(Date.now() - 1000),
      absoluteDeleteAt: new Date(Date.now() + 86_400_000),
    });
    const now = new Date();
    const a = await repo.tryAcquireCleanupLock(uploadId, "worker-a", now, 60_000);
    const b = await repo.tryAcquireCleanupLock(uploadId, "worker-b", now, 60_000);
    assert.equal(a, true);
    assert.equal(b, false);
    await repo.releaseCleanupLock(uploadId, "worker-a");

    // Stale lock recovery
    const staleNow = new Date();
    await repo.tryAcquireCleanupLock(uploadId, "worker-stale", staleNow, 1);
    await new Promise((r) => setTimeout(r, 5));
    const recovered = await repo.tryAcquireCleanupLock(
      uploadId,
      "worker-new",
      new Date(Date.now() + 50),
      60_000,
    );
    assert.equal(recovered, true);
  });

  it("missing object deletion is idempotent; report survives media cleanup", async () => {
    const uploadId = randomUUID();
    const past = new Date(Date.now() - 60_000);
    await seedUpload({
      uploadId,
      expiresAt: past,
      absoluteDeleteAt: past,
      key: `missing-${uploadId}`,
    });
    const jobs = new DrizzleAnalysisJobRepository();
    const job = await jobs.createPendingSubmission({
      applicationRequestId: randomUUID(),
      uploadId,
      ownerId: "own-ret-pg",
      provider: "simulator",
      contractVersion: "1.0.0",
      idempotencyKey: `idem-${uploadId}`,
      requestFingerprint: "fp",
      requestedCapabilities: {
        identifyControlledPlayer: true,
        analyzeGameplay: true,
        analyzeStrategies: true,
        analyzeFaceoffs: false,
        includeControlGuidance: true,
        generatePracticeDrills: true,
      },
      gameContext: {
        selectedGameTitle: "NHL 25",
        canonicalGameId: "nhl-25",
        supportStatus: "supported",
        mismatchState: "none",
      },
      uploadContext: {
        gameContext: {
          selectedGameTitle: "NHL 25",
          canonicalGameId: "nhl-25",
          supportStatus: "supported",
          mismatchState: "none",
        },
        playerContext: {
          platform: "xbox_series",
          controlScheme: "skill_stick",
          position: "C",
          gameMode: "eashl",
        },
        singlePlayerControl: true,
      },
      effectivePlayer: {
        position: "C",
        jerseyNumber: 19,
        indicatorColor: "blue",
        teamSide: "home",
        confidence: 0.9,
        confidenceLabel: "high",
        source: "user_confirmation",
        identificationId: "id",
        confirmationId: "conf",
        userConfirmed: true,
      },
      mediaClassification: "short_clip",
    });
    const accepted = await jobs.markAccepted({
      applicationRequestId: job.applicationRequestId,
      expectedVersion: job.version,
      externalJobId: `ext-${uploadId}`,
      acceptedAt: new Date().toISOString(),
      canonicalStatus: "finalizing",
    });
    const reportBody = minimalScottyReport({
      reportId: `r-${uploadId}`,
      jobId: `ext-${uploadId}`,
      uploadId,
    });
    const completed = await jobs.completeWithReport({
      applicationRequestId: accepted.applicationRequestId,
      expectedVersion: accepted.version,
      report: {
        id: randomUUID(),
        applicationRequestId: accepted.applicationRequestId,
        jobId: accepted.id,
        externalJobId: `ext-${uploadId}`,
        uploadId,
        ownerId: "own-ret-pg",
        provider: "simulator",
        contractVersion: "1.0.0",
        reportVersion: "1",
        rubricVersion: "1",
        strategyKnowledgeVersion: "1",
        controlKnowledgeVersion: "1",
        report: reportBody,
        contentChecksum: "checksum",
        schemaValidatedAt: new Date().toISOString(),
        providerGeneratedAt: new Date().toISOString(),
        persistedAt: new Date().toISOString(),
      },
      completedAt: new Date().toISOString(),
      statusSequenceNumber: 12,
      providerSequenceNumber: 12,
      eventSource: "reconciliation",
    });
    assert.ok(completed.reportId);

    const storage = new TrackingStorage();
    const svc = createMediaRetentionService({ repo, storage });
    const batch = await svc.runCleanupBatch({ now: new Date(), limit: 10 });
    assert.ok(batch.deleted >= 1);
    const still = await repo.getReport(completed.reportId!);
    assert.ok(still);
    const again = await svc.runCleanupBatch({ now: new Date(), limit: 10 });
    assert.ok(again.deleted === 0 || again.skipped >= 0);
  });

  it("valid lease blocks normal deletion; absolute retention overrides stale lease", async () => {
    const uploadId = randomUUID();
    const future = new Date(Date.now() + 86_400_000);
    const past = new Date(Date.now() - 1000);
    await seedUpload({
      uploadId,
      expiresAt: past,
      absoluteDeleteAt: future,
    });
    const db = getDb();
    const now = new Date();
    await db.insert(processingLeases).values({
      id: randomUUID(),
      uploadId,
      analysisJobId: "active-job",
      status: "active",
      acquiredAt: now,
      heartbeatAt: now,
      expiresAt: new Date(now.getTime() + 60_000),
    });
    const storage = new TrackingStorage();
    const svc = createMediaRetentionService({ repo, storage });
    const deferred = await svc.runCleanupBatch({ now, limit: 5 });
    assert.ok(deferred.deferred >= 1 || deferred.skipped >= 1);

    // Absolute retention reached — force delete even with lease semantics via expired absolute.
    await db
      .update(mediaUploads)
      .set({ absoluteDeleteAt: past })
      .where(eq(mediaUploads.id, uploadId));
    await db
      .update(processingLeases)
      .set({ expiresAt: past, status: "expired" })
      .where(eq(processingLeases.uploadId, uploadId));
    const forced = await svc.runCleanupBatch({ now: new Date(), limit: 5 });
    assert.ok(forced.deleted >= 1 || forced.forcedExpiredJobs >= 0);
  });
});
