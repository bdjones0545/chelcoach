/**
 * Step 6 — durable analysis job contract tests (in-memory adapter).
 */
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { createHash, randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { createApp } from "../../app";
import { createOwnerSession, resetSessionsForTests } from "../../auth/session";
import { FakeMediaInspector, setMediaInspectorForTests } from "../../media/inspector";
import { resetMediaObjectStorageForTests } from "../../mediaStorage";
import { resetProfileRepositoryForTests } from "../../profile/repository";
import { resetRetentionPolicyCacheForTests } from "../../retention/policy";
import { resetUploadRepositoryForTests } from "../../uploads/repository";
import { resetIdentificationRepositoryForTests } from "../../identification/repository";
import {
  FakeConfirmationFrameExtractor,
  setConfirmationFrameExtractorForTests,
} from "../../identification/extractor";
import { FakeScottyProvider } from "../fakeProvider";
import { resetScottyProviderForTests, setScottyProviderForTests } from "../factory";
import { SimulatorScottyProvider } from "../simulator/simulatorProvider";
import { FakeClock } from "../simulator/clock";
import {
  InMemorySimulatorJobRepository,
  resetSimulatorJobRepositoryForTests,
  setSimulatorJobRepositoryForTests,
} from "../simulator/repository";
import { TEST_SIMULATOR_TIMINGS } from "../simulator/timings";
import { evaluateProviderStatusUpdate } from "./sequence";
import { isLegalStatusTransition } from "./transitions";
import {
  InMemoryAnalysisJobRepository,
  OptimisticConcurrencyError,
  resetAnalysisJobRepositoryForTests,
  setAnalysisJobRepositoryForTests,
  getAnalysisJobRepository,
} from "./jobRepository";
import { synchronizeJob, toPublicJobStatus } from "./syncService";
import { AnalysisReconciliationService } from "./reconciliationService";
import type { AnalysisJob, CreateAnalysisJobInput } from "./types";
import { scottyAnalysisSubmissionSchema } from "../../scottyContract";

function baseCreate(overrides: Partial<CreateAnalysisJobInput> = {}): CreateAnalysisJobInput {
  return {
    applicationRequestId: overrides.applicationRequestId ?? randomUUID(),
    uploadId: overrides.uploadId ?? randomUUID(),
    ownerId: overrides.ownerId ?? "own-1",
    provider: overrides.provider ?? "simulator",
    contractVersion: "1.0.0",
    idempotencyKey: overrides.idempotencyKey ?? `idem-${randomUUID()}`,
    requestFingerprint: overrides.requestFingerprint ?? "fp-1",
    requestedCapabilities: {
      identifyControlledPlayer: true,
      analyzeGameplay: true,
      analyzeStrategies: true,
      analyzeFaceoffs: true,
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
        jerseyNumber: 17,
        indicatorColor: "blue",
        teamSide: "home",
      },
      singlePlayerControl: true,
    },
    effectivePlayer: {
      position: "C",
      jerseyNumber: 17,
      indicatorColor: "blue",
      teamSide: "home",
      confidence: 0.9,
      confidenceLabel: "very_high",
      source: "user_confirmation",
      identificationId: "id-1",
      confirmationId: "conf-1",
      userConfirmed: true,
    },
    mediaClassification: "short_clip",
    ...overrides,
  };
}

beforeEach(() => {
  process.env.NODE_ENV = "test";
  process.env.CHELCOACH_FORCE_MEMORY_REPOS = "1";
  resetAnalysisJobRepositoryForTests();
  resetSimulatorJobRepositoryForTests();
  resetScottyProviderForTests();
});

describe("canonical transitions + sequence", () => {
  it("allows legal shortcuts and rejects terminal regression", () => {
    assert.equal(isLegalStatusTransition("queued", "analyzing_gameplay"), true);
    assert.equal(isLegalStatusTransition("analyzing_gameplay", "completed", { reportAvailable: true }), true);
    assert.equal(isLegalStatusTransition("completed", "analyzing_gameplay"), false);
    assert.equal(isLegalStatusTransition("failed", "completed"), false);
    assert.equal(isLegalStatusTransition("cancelled", "completed"), false);
  });

  it("evaluates advance / idempotent / stale / conflict", () => {
    const job = {
      ...({} as AnalysisJob),
      canonicalStatus: "queued" as const,
      providerStatus: "queued" as const,
      statusSequenceNumber: 1,
      providerSequenceNumber: 1,
      reportAvailable: false,
    };
    assert.equal(
      evaluateProviderStatusUpdate({
        currentJob: job,
        incoming: {
          contractVersion: "1.0.0",
          jobId: "j",
          uploadId: "u",
          provider: "simulator",
          status: "inspecting_input",
          sequenceNumber: 2,
          reportReady: false,
          updatedAt: new Date().toISOString(),
        },
      }).decision,
      "advance",
    );
    assert.equal(
      evaluateProviderStatusUpdate({
        currentJob: job,
        incoming: {
          contractVersion: "1.0.0",
          jobId: "j",
          uploadId: "u",
          provider: "simulator",
          status: "queued",
          sequenceNumber: 1,
          reportReady: false,
          updatedAt: new Date().toISOString(),
        },
      }).decision,
      "idempotent",
    );
    assert.equal(
      evaluateProviderStatusUpdate({
        currentJob: { ...job, providerSequenceNumber: 3, statusSequenceNumber: 3 },
        incoming: {
          contractVersion: "1.0.0",
          jobId: "j",
          uploadId: "u",
          provider: "simulator",
          status: "queued",
          sequenceNumber: 1,
          reportReady: false,
          updatedAt: new Date().toISOString(),
        },
      }).decision,
      "stale",
    );
    assert.equal(
      evaluateProviderStatusUpdate({
        currentJob: job,
        incoming: {
          contractVersion: "1.0.0",
          jobId: "j",
          uploadId: "u",
          provider: "simulator",
          status: "analyzing_gameplay",
          sequenceNumber: 1,
          reportReady: false,
          updatedAt: new Date().toISOString(),
        },
      }).decision,
      "conflict",
    );
  });
});

describe("in-memory analysis job repository", () => {
  it("creates jobs with unique request / idempotency keys and owned lookup", async () => {
    const repo = new InMemoryAnalysisJobRepository();
    setAnalysisJobRepositoryForTests(repo);
    const a = await repo.createPendingSubmission(baseCreate({ idempotencyKey: "idem-a" }));
    assert.equal(a.canonicalStatus, "queued");
    assert.equal(a.submissionAcceptanceState, "pending");
    assert.ok(a.requestedCapabilities.analyzeGameplay);
    assert.equal(a.gameContext.canonicalGameId, "nhl-25");
    assert.equal(a.effectivePlayer.userConfirmed, true);

    const dup = await repo.createPendingSubmission(
      baseCreate({
        applicationRequestId: randomUUID(),
        idempotencyKey: "idem-a",
        requestFingerprint: "other",
      }),
    );
    // Same idempotency returns existing (unique)
    assert.equal(dup.applicationRequestId, a.applicationRequestId);

    const owned = await repo.getOwnedJob(a.ownerId, a.applicationRequestId);
    assert.ok(owned);
    assert.equal(await repo.getOwnedJob("other", a.applicationRequestId), null);

    const accepted = await repo.markAccepted({
      applicationRequestId: a.applicationRequestId,
      expectedVersion: a.version,
      externalJobId: "ext-1",
      acceptedAt: new Date().toISOString(),
      canonicalStatus: "queued",
      pollAfterMs: 1000,
    });
    assert.equal(accepted.submissionAcceptanceState, "accepted");
    assert.equal(accepted.externalJobId, "ext-1");

    await assert.rejects(
      () =>
        repo.markAccepted({
          applicationRequestId: a.applicationRequestId,
          expectedVersion: a.version,
          externalJobId: "ext-2",
          acceptedAt: new Date().toISOString(),
          canonicalStatus: "queued",
        }),
      OptimisticConcurrencyError,
    );

    const events = await repo.listEvents(a.applicationRequestId);
    assert.ok(events.some((e) => e.eventType === "job_created"));
    assert.ok(events.some((e) => e.eventType === "provider_accepted"));
  });

  it("marks acceptance unknown and lists reconciliation candidates", async () => {
    const repo = getAnalysisJobRepository();
    const job = await repo.createPendingSubmission(baseCreate());
    const unknown = await repo.markAcceptanceUnknown(job.applicationRequestId, job.version);
    assert.equal(unknown.submissionAcceptanceState, "acceptance_unknown");
    assert.equal(unknown.reconciliationRequired, true);
    const candidates = await repo.listReconciliationCandidates({ now: new Date(), limit: 10 });
    assert.ok(candidates.some((c) => c.applicationRequestId === job.applicationRequestId));
  });

  it("completes only with persisted report and checksum", async () => {
    const repo = getAnalysisJobRepository();
    const job = await repo.createPendingSubmission(baseCreate());
    const accepted = await repo.markAccepted({
      applicationRequestId: job.applicationRequestId,
      expectedVersion: job.version,
      externalJobId: "ext-r",
      acceptedAt: new Date().toISOString(),
      canonicalStatus: "analyzing_gameplay",
    });
    const report = {
      id: randomUUID(),
      applicationRequestId: accepted.applicationRequestId,
      jobId: accepted.id,
      externalJobId: "ext-r",
      uploadId: accepted.uploadId,
      ownerId: accepted.ownerId,
      provider: accepted.provider,
      contractVersion: "1.0.0",
      reportVersion: "report-v1",
      rubricVersion: "rubric-v1",
      strategyKnowledgeVersion: "strategy-v1",
      controlKnowledgeVersion: "controls-v1",
      report: {
        contractVersion: "1.0.0",
        reportId: "r1",
        jobId: "ext-r",
        uploadId: accepted.uploadId,
        generatedAt: new Date().toISOString(),
        gameContext: accepted.gameContext,
        playerAttribution: {
          position: "C" as const,
          jerseyNumber: 17,
          indicatorColor: "blue",
          confirmationState: "confirmed" as const,
        },
        controlledPlayerConfidence: "high" as const,
        playerSpecificObservations: [],
        strengths: ["a"],
        priorityImprovements: ["b"],
        strategyAnalysis: {
          observedStrategy: "x",
          strategyCategory: "forecheck",
          controlledPlayerPosition: "C" as const,
          playerResponsibility: "y",
          executionAssessment: "z",
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
      },
      contentChecksum: createHash("sha256").update("x").digest("hex"),
      schemaValidatedAt: new Date().toISOString(),
      providerGeneratedAt: new Date().toISOString(),
      persistedAt: new Date().toISOString(),
    };
    const completed = await repo.completeWithReport({
      applicationRequestId: accepted.applicationRequestId,
      expectedVersion: accepted.version,
      report,
      completedAt: new Date().toISOString(),
      statusSequenceNumber: 10,
      providerSequenceNumber: 10,
      eventSource: "provider_poll",
    });
    assert.equal(completed.canonicalStatus, "completed");
    assert.equal(completed.reportAvailable, true);
    const stored = await repo.getReportByApplicationRequestId(completed.applicationRequestId);
    assert.ok(stored);
    assert.ok(stored.contentChecksum);

    const publicStatus = toPublicJobStatus(completed);
    assert.equal(JSON.stringify(publicStatus).includes("idempotencyKey"), false);
    assert.equal(JSON.stringify(publicStatus).includes("requestFingerprint"), false);
    assert.equal(JSON.stringify(publicStatus).includes("SCOTTY_BASE_URL"), false);
    assert.equal(publicStatus.statusLabel, "Complete");
  });

  it("callback event dedupe is idempotent", async () => {
    const repo = getAnalysisJobRepository();
    const r1 = await repo.recordCallbackEvent({
      eventId: "evt-1",
      provider: "scotty",
      externalJobId: "ext",
      sequenceNumber: 2,
    });
    const r2 = await repo.recordCallbackEvent({
      eventId: "evt-1",
      provider: "scotty",
      externalJobId: "ext",
      sequenceNumber: 2,
    });
    assert.equal(r1.inserted, true);
    assert.equal(r2.inserted, false);
  });
});

describe("simulator restart via repository swap", () => {
  it("continues lifecycle after repository recreation with same durable rows", async () => {
    const clock = new FakeClock();
    const sharedRepo = new InMemorySimulatorJobRepository();
    setSimulatorJobRepositoryForTests(sharedRepo);
    const provider = new SimulatorScottyProvider({
      clock,
      timings: TEST_SIMULATOR_TIMINGS,
      repo: sharedRepo,
      forcedScenario: "successful_short_clip",
    });
    const sub = scottyAnalysisSubmissionSchema.parse({
      requestId: "req-restart",
      idempotencyKey: "idem-restart",
      uploadId: "up-restart",
      ownerReference: "own",
      gameContext: baseCreate().gameContext,
      playerContext: baseCreate().uploadContext.playerContext,
      effectivePlayer: baseCreate().effectivePlayer,
      mediaMetadata: {
        durationSec: 90,
        width: 640,
        height: 360,
        inspectedAt: clock.now().toISOString(),
      },
      mediaClassification: "short_clip",
      mediaTransfer: { type: "gateway_pull", uploadReference: "up-restart" },
      retentionExpiresAt: new Date("2026-08-01T12:00:00.000Z").toISOString(),
      createdAt: clock.now().toISOString(),
    });
    const receipt = await provider.submitAnalysis(sub);
    clock.advance(150);
    const mid = await provider.getJob({
      externalJobId: receipt.externalJobId,
      applicationRequestId: receipt.applicationRequestId,
    });
    assert.notEqual(mid.status, "completed");

    // Simulate process restart: new provider instance, same durable repo.
    const provider2 = new SimulatorScottyProvider({
      clock,
      timings: TEST_SIMULATOR_TIMINGS,
      repo: sharedRepo,
      forcedScenario: "successful_short_clip",
    });
    clock.advance(5_000);
    const done = await provider2.getJob({
      externalJobId: receipt.externalJobId,
      applicationRequestId: receipt.applicationRequestId,
    });
    assert.equal(done.status, "completed");
    const report = await provider2.getReport({ externalJobId: receipt.externalJobId });
    assert.equal(report.uploadId, "up-restart");
  });
});

describe("reconciliation batch", () => {
  it("is bounded and advances active simulator jobs", async () => {
    const simRepo = new InMemorySimulatorJobRepository();
    setSimulatorJobRepositoryForTests(simRepo);
    // Zero-duration timings + system clock so createScottyProviderForMode sync works.
    const instant = {
      ...TEST_SIMULATOR_TIMINGS,
      queuedMs: 0,
      inspectingMs: 0,
      extractingMs: 0,
      identifyingMs: 0,
      analyzingMs: 0,
      validatingMs: 0,
      finalizingMs: 0,
    };
    const sim = new SimulatorScottyProvider({
      timings: instant,
      repo: simRepo,
      forcedScenario: "successful_short_clip",
    });
    setScottyProviderForTests(sim);

    const jobs = getAnalysisJobRepository();
    const created = await jobs.createPendingSubmission(
      baseCreate({ provider: "simulator", idempotencyKey: "idem-recon" }),
    );
    const sub = scottyAnalysisSubmissionSchema.parse({
      requestId: created.applicationRequestId,
      idempotencyKey: created.idempotencyKey,
      uploadId: created.uploadId,
      ownerReference: created.ownerId,
      gameContext: created.gameContext,
      playerContext: created.uploadContext.playerContext,
      effectivePlayer: created.effectivePlayer,
      mediaMetadata: {
        durationSec: 90,
        width: 640,
        height: 360,
        inspectedAt: new Date().toISOString(),
      },
      mediaClassification: "short_clip",
      mediaTransfer: { type: "gateway_pull", uploadReference: created.uploadId },
      retentionExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      createdAt: new Date().toISOString(),
    });
    const receipt = await sim.submitAnalysis(sub);
    await jobs.markAccepted({
      applicationRequestId: created.applicationRequestId,
      expectedVersion: created.version,
      externalJobId: receipt.externalJobId,
      acceptedAt: receipt.acceptedAt,
      canonicalStatus: "queued",
      pollAfterMs: 1,
    });

    const batch = await new AnalysisReconciliationService().runBatch({
      now: new Date(Date.now() + 60_000),
      limit: 10,
    });
    assert.ok(batch.examined <= 10);
    assert.ok(batch.examined >= 1);
    assert.ok(batch.advanced + batch.unchanged + batch.degraded + batch.failed >= 1);
    const after = await jobs.getByApplicationRequestId(created.applicationRequestId);
    assert.equal(after?.canonicalStatus, "completed");
    assert.equal(after?.reportAvailable, true);
  });
});

describe("public status omits sensitive fields via API", () => {
  async function withServer(fn: (base: string, token: string) => Promise<void>) {
    resetSessionsForTests();
    resetUploadRepositoryForTests();
    resetProfileRepositoryForTests();
    resetMediaObjectStorageForTests();
    resetRetentionPolicyCacheForTests();
    resetIdentificationRepositoryForTests();
    resetAnalysisJobRepositoryForTests();
    setMediaInspectorForTests(
      new FakeMediaInspector({
        mimeType: "video/mp4",
        byteSize: 2048,
        durationSeconds: 90,
        width: 640,
        height: 360,
        hasVideoStream: true,
      }),
    );
    setConfirmationFrameExtractorForTests(new FakeConfirmationFrameExtractor());
    setScottyProviderForTests(new FakeScottyProvider("accept"));
    const app = createApp();
    const server = app.listen(0);
    await new Promise<void>((r) => server.once("listening", () => r()));
    const { port } = server.address() as AddressInfo;
    const session = createOwnerSession();
    try {
      await fn(`http://127.0.0.1:${port}`, session.token);
    } finally {
      server.close();
      setMediaInspectorForTests(undefined);
    }
  }

  it("authenticated status route returns safe public payload", async () => {
    process.env.CHELCOACH_ALLOW_IDENTITY_FIXTURES = "1";
    await withServer(async (base, token) => {
      const created = (await (
        await fetch(`${base}/api/uploads`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify({
            filename: "g.mp4",
            contentType: "video/mp4",
            sizeBytes: 2048,
            context: baseCreate().uploadContext,
          }),
        })
      ).json()) as { uploadId: string; uploadUrl: string };
      await fetch(`${base}${created.uploadUrl}`, {
        method: "PUT",
        headers: { authorization: `Bearer ${token}`, "content-type": "video/mp4" },
        body: Buffer.alloc(2048, 1),
      });
      await fetch(`${base}/api/uploads/${created.uploadId}/player-identification`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ fixtureScenario: "high_confidence_center" }),
      });
      const submit = await fetch(`${base}/api/uploads/${created.uploadId}/analysis`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      assert.equal(submit.status, 202, await submit.clone().text());
      const body = (await submit.json()) as { applicationRequestId: string };
      const statusRes = await fetch(`${base}/api/analysis/${body.applicationRequestId}`, {
        headers: { authorization: `Bearer ${token}` },
      });
      assert.equal(statusRes.status, 200);
      const status = await statusRes.json();
      const raw = JSON.stringify(status);
      assert.equal(raw.includes("idempotencyKey"), false);
      assert.equal(raw.includes("requestFingerprint"), false);
      assert.equal(raw.includes("storageObjectKey"), false);
      assert.ok(status.statusLabel);
    });
  });
});

// Keep unused import referenced for typecheck of synchronizeJob in suites above.
void synchronizeJob;
