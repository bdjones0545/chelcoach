/**
 * Step 6 — real Postgres integration tests for DrizzleAnalysisJobRepository.
 * Skipped unless CHELCOACH_RUN_PG_TESTS=1 and DATABASE_URL is set.
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { getDb, isDbConfigured } from "../../db/client";
import { mediaUploads } from "../../db/schema";
import { DrizzleAnalysisJobRepository, checksumReport } from "./drizzleJobRepository";
import { setAnalysisJobRepositoryForTests } from "./jobRepository";
import type { CreateAnalysisJobInput } from "./types";

const runPg = process.env.CHELCOACH_RUN_PG_TESTS === "1" && isDbConfigured();

function createInput(overrides: Partial<CreateAnalysisJobInput> = {}): CreateAnalysisJobInput {
  return {
    applicationRequestId: overrides.applicationRequestId ?? randomUUID(),
    uploadId: overrides.uploadId ?? randomUUID(),
    ownerId: "own-pg-1",
    provider: "simulator",
    contractVersion: "1.0.0",
    idempotencyKey: overrides.idempotencyKey ?? `idem-${randomUUID()}`,
    requestFingerprint: "fp-pg",
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
    ...overrides,
  };
}

describe("drizzle analysis job repository (postgres)", { skip: !runPg }, () => {
  const repo = new DrizzleAnalysisJobRepository();

  before(async () => {
    setAnalysisJobRepositoryForTests(repo);
  });

  beforeEach(async () => {
    const db = getDb();
    await db.execute(sql`truncate table scotty_callback_events, scotty_analysis_job_events, scotty_analysis_reports, scotty_analysis_jobs, scotty_simulator_jobs, media_uploads cascade`);
  });

  after(async () => {
    // leave DB for inspection if needed
  });

  async function seedUpload(uploadId: string): Promise<void> {
    const db = getDb();
    const now = new Date();
    await db.insert(mediaUploads).values({
      id: uploadId,
      ownerId: "own-pg-1",
      storageProvider: "memory",
      storageObjectKey: `obj-${uploadId}`,
      originalFilename: "g.mp4",
      displayFilename: "g.mp4",
      mimeType: "video/mp4",
      byteSize: 2048,
      uploadStatus: "ready",
      retentionPolicyVersion: "v1",
      expiresAt: new Date(now.getTime() + 86_400_000),
      absoluteDeleteAt: new Date(now.getTime() + 172_800_000),
      gameplayContext: createInput().uploadContext,
      trustedMedia: {
        durationSec: 90,
        width: 640,
        height: 360,
        inspectedAt: now.toISOString(),
      },
      mediaClassification: "short_clip",
      createdAt: now,
      updatedAt: now,
    });
  }

  it("creates job with unique constraints and indexes usable", async () => {
    const uploadId = randomUUID();
    await seedUpload(uploadId);
    const job = await repo.createPendingSubmission(createInput({ uploadId, idempotencyKey: "idem-pg-1" }));
    assert.equal(job.uploadId, uploadId);
    const again = await repo.createPendingSubmission(
      createInput({ uploadId, applicationRequestId: randomUUID(), idempotencyKey: "idem-pg-1" }),
    );
    assert.equal(again.applicationRequestId, job.applicationRequestId);

    const accepted = await repo.markAccepted({
      applicationRequestId: job.applicationRequestId,
      expectedVersion: job.version,
      externalJobId: "sim_ext_1",
      acceptedAt: new Date().toISOString(),
      canonicalStatus: "queued",
      pollAfterMs: 1000,
    });
    assert.equal(accepted.externalJobId, "sim_ext_1");

    const byExt = await repo.getByExternalJobId("simulator", "sim_ext_1");
    assert.ok(byExt);

    const owned = await repo.getOwnedJob("own-pg-1", job.applicationRequestId);
    assert.ok(owned);
    assert.equal(await repo.getOwnedJob("other", job.applicationRequestId), null);

    // Unique provider+external
    const upload2 = randomUUID();
    await seedUpload(upload2);
    const job2 = await repo.createPendingSubmission(
      createInput({ uploadId: upload2, idempotencyKey: "idem-pg-2" }),
    );
    await assert.rejects(() =>
      repo.markAccepted({
        applicationRequestId: job2.applicationRequestId,
        expectedVersion: job2.version,
        externalJobId: "sim_ext_1",
        acceptedAt: new Date().toISOString(),
        canonicalStatus: "queued",
      }),
    );
  });

  it("persists report transactionally and supports callback dedupe", async () => {
    const uploadId = randomUUID();
    await seedUpload(uploadId);
    const job = await repo.createPendingSubmission(createInput({ uploadId }));
    const accepted = await repo.markAccepted({
      applicationRequestId: job.applicationRequestId,
      expectedVersion: job.version,
      externalJobId: "sim_ext_report",
      acceptedAt: new Date().toISOString(),
      canonicalStatus: "finalizing",
    });
    const reportBody = {
      contractVersion: "1.0.0",
      reportId: "r-pg",
      jobId: "sim_ext_report",
      uploadId,
      generatedAt: new Date().toISOString(),
      gameContext: accepted.gameContext,
      playerAttribution: {
        position: "C" as const,
        jerseyNumber: 19,
        indicatorColor: "blue",
        confirmationState: "confirmed" as const,
      },
      controlledPlayerConfidence: "high" as const,
      playerSpecificObservations: [],
      strengths: ["s"],
      priorityImprovements: ["p"],
      strategyAnalysis: {
        observedStrategy: "o",
        strategyCategory: "forecheck",
        controlledPlayerPosition: "C" as const,
        playerResponsibility: "r",
        executionAssessment: "e",
        strategicStrengths: [],
        strategicImprovements: [],
        knownCounters: [],
        requiredMechanics: [],
        confidence: "moderate" as const,
      },
      controlGuidance: [],
      practiceDrills: [],
      uncertaintyDisclosures: [],
      rubricVersion: "rubric-v1",
      strategyKnowledgeVersion: "strategy-v1",
      controlKnowledgeVersion: "controls-v1",
      reportVersion: "report-v1",
      qualityValidation: {
        passed: true,
        issues: [],
        validatedAt: new Date().toISOString(),
      },
    };
    const completed = await repo.completeWithReport({
      applicationRequestId: accepted.applicationRequestId,
      expectedVersion: accepted.version,
      report: {
        id: randomUUID(),
        applicationRequestId: accepted.applicationRequestId,
        jobId: accepted.id,
        externalJobId: "sim_ext_report",
        uploadId,
        ownerId: accepted.ownerId,
        provider: "simulator",
        contractVersion: "1.0.0",
        reportVersion: "report-v1",
        rubricVersion: "rubric-v1",
        strategyKnowledgeVersion: "strategy-v1",
        controlKnowledgeVersion: "controls-v1",
        report: reportBody,
        contentChecksum: checksumReport(reportBody),
        schemaValidatedAt: new Date().toISOString(),
        providerGeneratedAt: reportBody.generatedAt,
        persistedAt: new Date().toISOString(),
      },
      completedAt: new Date().toISOString(),
      statusSequenceNumber: 12,
      providerSequenceNumber: 12,
      eventSource: "reconciliation",
    });
    assert.equal(completed.canonicalStatus, "completed");
    assert.equal(completed.reportAvailable, true);
    const stored = await repo.getReportByApplicationRequestId(completed.applicationRequestId);
    assert.ok(stored?.contentChecksum);

    const d1 = await repo.claimCallbackEvent({
      eventId: "cb-1",
      provider: "scotty",
      externalJobId: "x",
      sequenceNumber: 1,
    });
    await repo.completeCallbackEvent("scotty", "cb-1", "processed");
    const d2 = await repo.claimCallbackEvent({
      eventId: "cb-1",
      provider: "scotty",
      externalJobId: "x",
      sequenceNumber: 1,
    });
    assert.equal(d1.claimed, true);
    assert.equal(d2.claimed, false);

    const concurrentInput = {
      eventId: "cb-concurrent",
      provider: "scotty" as const,
      externalJobId: "x-concurrent",
      sequenceNumber: 2,
    };
    const concurrent = await Promise.all([
      repo.claimCallbackEvent(concurrentInput),
      repo.claimCallbackEvent(concurrentInput),
    ]);
    assert.equal(concurrent.filter((result) => result.claimed).length, 1);

    const retryInput = {
      eventId: "cb-retry",
      provider: "scotty" as const,
      externalJobId: "x-retry",
      sequenceNumber: 3,
    };
    assert.equal((await repo.claimCallbackEvent(retryInput)).claimed, true);
    await repo.releaseCallbackEvent("scotty", retryInput.eventId);
    assert.equal((await repo.claimCallbackEvent(retryInput)).claimed, true);
  });
});

if (!runPg) {
  describe("drizzle analysis job repository (postgres) — skipped notice", () => {
    it("reports missing DATABASE_URL / CHELCOACH_RUN_PG_TESTS coverage gate", () => {
      assert.ok(true);
    });
  });
}
