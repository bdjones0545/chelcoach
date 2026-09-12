/**
 * Scotty worker provider — the production analysis path, exercised with a fake vision model and
 * a fake frame sampler so nothing here touches ffmpeg or the network.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { AddressInfo } from "node:net";
import type {
  GameplayAnalysisModelOutput,
  IdentificationModelOutput,
  ModelUsage,
  VisionModelClient,
} from "../../ai/modelClient";
import { setVisionModelClientForTests } from "../../ai/modelClient";
import { createApp } from "../../app";
import { createOwnerSession, resetSessionsForTests } from "../../auth/session";
import { loadChelCoachConfig, resetChelCoachConfigCacheForTests } from "../../config/chelcoachConfig";
import { computeReadiness } from "../../config/readiness";
import {
  FakeConfirmationFrameExtractor,
  setConfirmationFrameExtractorForTests,
} from "../../identification/extractor";
import { resetIdentificationRepositoryForTests } from "../../identification/repository";
import { FakeMediaInspector, setMediaInspectorForTests } from "../../media/inspector";
import { setFrameSamplerForTests, type FrameSampler, type SampledFrame } from "../../media/frameSampler";
import { fakeJpeg } from "../../media/jpegFixture";
import { resetMediaObjectStorageForTests } from "../../mediaStorage";
import { resetProfileRepositoryForTests } from "../../profile/repository";
import { resetRetentionPolicyCacheForTests } from "../../retention/policy";
import { scottyAnalysisSubmissionSchema, scottyReportSchema, type ScottyAnalysisSubmission } from "../../scottyContract";
import { getUploadRepository, resetUploadRepositoryForTests } from "../../uploads/repository";
import { ProviderError } from "../errors";
import { providerCanServeProductionTraffic, resetScottyProviderForTests, setScottyProviderForTests } from "../factory";
import { resetAnalysisJobRepositoryForTests } from "../jobs/jobRepository";
import { resetAnalysisSubmissionRepositoryForTests } from "../submissionRepository";
import { ScottyWorkerProvider } from "./provider";
import { InMemoryScottyWorkerJobRepository, resetScottyWorkerJobRepositoryForTests, setScottyWorkerJobRepositoryForTests } from "./repository";
import { assembleScottyReport } from "./reportAssembler";
import { processScottyWorkerJob, runScottyWorkerBatch } from "./worker";

const NOW = new Date("2026-09-12T12:00:00.000Z");

function submission(overrides: Partial<ScottyAnalysisSubmission> = {}): ScottyAnalysisSubmission {
  return scottyAnalysisSubmissionSchema.parse({
    requestId: "req-sw-1",
    idempotencyKey: "idem-sw-1",
    uploadId: "up-sw-1",
    ownerReference: "own-sw-1",
    gameContext: { selectedGameTitle: "NHL 25", canonicalGameId: "nhl-25", supportStatus: "supported", mismatchState: "none" },
    playerContext: {
      platform: "xbox_series",
      controlScheme: "skill_stick",
      position: "C",
      gameMode: "eashl",
      jerseyNumber: 17,
      indicatorColor: "blue",
      teamSide: "home",
    },
    effectivePlayer: {
      position: "C",
      jerseyNumber: 17,
      indicatorColor: "blue",
      teamSide: "home",
      confidence: 0.93,
      confidenceLabel: "very_high",
      source: "user_confirmation",
      identificationId: "id-1",
      confirmationId: "conf-1",
      userConfirmed: true,
    },
    mediaMetadata: { durationSec: 90, width: 1280, height: 720, inspectedAt: NOW.toISOString() },
    mediaClassification: "short_clip",
    mediaTransfer: { type: "gateway_pull", uploadReference: "up-sw-1" },
    retentionExpiresAt: new Date(NOW.getTime() + 86_400_000).toISOString(),
    createdAt: NOW.toISOString(),
    ...overrides,
  });
}

function usage(): ModelUsage {
  return { inputTokens: 1200, outputTokens: 800, model: "claude-opus-5" };
}

function goodAnalysis(): GameplayAnalysisModelOutput {
  return {
    controlledPlayerConfidence: "moderate",
    observations: [
      {
        frameIndex: 0,
        category: "positioning",
        observedAction: "Center is below the hash marks on the strong side",
        attributionExplanation: "Blue indicator under #17",
        coachingInterpretation: "Stay above the puck to support the breakout",
        confidence: "moderate",
        recommendedMechanic: "gap_control",
      },
      {
        frameIndex: 2,
        category: "decision_making",
        observedAction: "Pass attempted through a defender's stick",
        attributionExplanation: "Blue indicator under #17 with the puck",
        coachingInterpretation: "Lift the pass over the stick or hold for the trailer",
        confidence: "high",
        recommendedMechanic: "saucer_pass",
      },
    ],
    strengths: ["Puck support in the neutral zone"],
    priorityImprovements: ["Shorter gap on entries"],
    strategyAnalysis: {
      observedStrategy: "1-2-2 neutral zone trap",
      strategyCategory: "neutral_zone",
      playerResponsibility: "Angle the carrier to the boards as F1",
      executionAssessment: "Arrived late in two sampled frames",
      strategicStrengths: ["Lane awareness"],
      strategicImprovements: ["Earlier first step"],
      recommendedAdjustment: null,
      knownCounters: ["Chip and chase"],
      requiredMechanics: ["gap_control"],
      confidence: "moderate",
      supportingFrameIndices: [0, 2],
    },
    faceoffAnalysis: null,
    practiceDrills: [
      {
        name: "Gap control reps",
        objective: "Hold a tight gap at the blue line",
        setup: "Practice mode, 1v1 entries",
        requiredMechanics: ["gap_control", "vision_control"],
        repetitionTarget: "10 entries",
        successCriteria: "Force 7 of 10 dump-ins",
        commonErrors: ["Backing in too early"],
        progression: null,
      },
    ],
    uncertaintyDisclosures: ["Jersey numbers were unreadable in two frames"],
  };
}

class FakeModel implements VisionModelClient {
  calls = 0;
  constructor(
    public configured: boolean,
    private analysis: () => GameplayAnalysisModelOutput | Error = goodAnalysis,
  ) {}
  async identifyControlledPlayer(): Promise<{ output: IdentificationModelOutput; usage: ModelUsage }> {
    throw new Error("not used here");
  }
  async analyzeGameplay(): Promise<{ output: GameplayAnalysisModelOutput; usage: ModelUsage }> {
    this.calls += 1;
    const out = this.analysis();
    if (out instanceof Error) throw out;
    return { output: out, usage: usage() };
  }
}

class FakeSampler implements FrameSampler {
  requests: number[][] = [];
  constructor(private fail = false) {}
  async sample(input: { timestampsSec: number[]; maxEdge: number }): Promise<SampledFrame[]> {
    this.requests.push(input.timestampsSec);
    if (this.fail) throw Object.assign(new Error("FRAME_EXTRACTION_FAILED"), { code: "FRAME_EXTRACTION_FAILED" });
    return input.timestampsSec.map((timestampSec) => ({
      timestampSec,
      mimeType: "image/jpeg" as const,
      width: input.maxEdge,
      height: Math.round((input.maxEdge * 9) / 16),
      bytes: fakeJpeg(input.maxEdge, Math.round((input.maxEdge * 9) / 16), 64),
    }));
  }
}

async function seedUpload(uploadId = "up-sw-1", overrides: Record<string, unknown> = {}) {
  const now = NOW.toISOString();
  await getUploadRepository().create({
    uploadId,
    ownerId: "own-sw-1",
    storageProvider: "memory",
    storageObjectKey: `chelcoach/uploads/own-sw-1/${uploadId}/source`,
    originalFilename: "game.mp4",
    displayFilename: "game.mp4",
    mimeType: "video/mp4",
    declaredByteSize: 2048,
    storedByteSize: 2048,
    trustedMedia: { durationSec: 90, width: 1280, height: 720, inspectedAt: now },
    mediaClassification: "short_clip",
    uploadStatus: "ready",
    context: {
      gameContext: { selectedGameTitle: "NHL 25", canonicalGameId: "nhl-25", supportStatus: "supported", mismatchState: "none" },
      playerContext: { platform: "xbox_series", controlScheme: "skill_stick", position: "C", gameMode: "eashl" },
      singlePlayerControl: true,
    },
    retentionPolicyVersion: "retention-v1",
    expiresAt: new Date(NOW.getTime() + 86_400_000).toISOString(),
    absoluteDeleteAt: new Date(NOW.getTime() + 2 * 86_400_000).toISOString(),
    pendingExpiresAt: new Date(NOW.getTime() + 7_200_000).toISOString(),
    createdAt: now,
    deletionAttemptCount: 0,
    ...overrides,
  } as Parameters<ReturnType<typeof getUploadRepository>["create"]>[0]);
}

let repo: InMemoryScottyWorkerJobRepository;

beforeEach(() => {
  process.env.NODE_ENV = "test";
  process.env.CHELCOACH_FORCE_MEMORY_REPOS = "1";
  repo = new InMemoryScottyWorkerJobRepository();
  setScottyWorkerJobRepositoryForTests(repo);
  resetUploadRepositoryForTests();
  resetScottyProviderForTests();
});

afterEach(() => {
  resetScottyWorkerJobRepositoryForTests();
  setFrameSamplerForTests(undefined);
  setVisionModelClientForTests(null);
  resetScottyProviderForTests();
});

describe("scotty worker provider boundary", () => {
  it("accepts a submission as a durable queued job and reports it through getJob", async () => {
    const provider = new ScottyWorkerProvider({ repo, modelConfigured: true });
    const receipt = await provider.submitAnalysis(submission());
    assert.equal(receipt.provider, "scotty_worker");
    assert.equal(receipt.status, "queued");
    assert.match(receipt.externalJobId, /^sw_[a-f0-9]{20}$/);

    const status = await provider.getJob({ externalJobId: receipt.externalJobId, applicationRequestId: "req-sw-1" });
    assert.equal(status.status, "queued");
    assert.equal(status.sequenceNumber, 1);
    assert.equal(status.reportReady, false);
    assert.equal(status.terminal, false);
    assert.ok(status.pollAfterMs && status.pollAfterMs > 0);

    await assert.rejects(
      () => provider.getReport({ externalJobId: receipt.externalJobId }),
      (err: unknown) => err instanceof ProviderError && err.code === "REPORT_NOT_READY",
    );
  });

  it("is idempotent on the key and rejects a different fingerprint under the same key", async () => {
    const provider = new ScottyWorkerProvider({ repo, modelConfigured: true });
    const a = await provider.submitAnalysis(submission());
    const b = await provider.submitAnalysis(submission());
    assert.equal(a.externalJobId, b.externalJobId);
    await assert.rejects(
      () => provider.submitAnalysis(submission({ mediaClassification: "extended_clip" })),
      (err: unknown) => err instanceof ProviderError && err.code === "IDEMPOTENCY_CONFLICT",
    );
  });

  it("declares production capability from model credentials, never from configuration alone", () => {
    assert.equal(new ScottyWorkerProvider({ repo, modelConfigured: true }).canServeProductionTraffic, true);
    assert.equal(new ScottyWorkerProvider({ repo, modelConfigured: false }).canServeProductionTraffic, false);
    setScottyProviderForTests(new ScottyWorkerProvider({ repo, modelConfigured: false }));
    assert.equal(providerCanServeProductionTraffic("scotty_worker"), false);
    setScottyProviderForTests(new ScottyWorkerProvider({ repo, modelConfigured: true }));
    assert.equal(providerCanServeProductionTraffic("scotty_worker"), true);
  });

  it("requires ANTHROPIC_API_KEY in production and blocks readiness without it", () => {
    const base = {
      NODE_ENV: "production",
      CHELCOACH_AUTH_MODE: "supabase_auth",
      CHELCOACH_PRODUCTION_AUTH_READY: "true",
      SUPABASE_URL: "https://example.supabase.co",
      SUPABASE_ANON_KEY: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.test-anon-key",
      SUPABASE_SERVICE_ROLE_KEY: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.test-service-role",
      DATABASE_URL: "postgresql://user:pass@db.example:5432/chelcoach",
      CHELCOACH_FORCE_MEMORY_REPOS: "0",
      CHELCOACH_MEDIA_STORAGE_MODE: "supabase_storage",
      CHELCOACH_PRODUCTION_MEDIA_STORAGE_READY: "true",
      CORS_ORIGIN: "https://chelcoach.io",
      CHELCOACH_LEGACY_UPLOAD_ENABLED: "false",
      CHELCOACH_ANALYSIS_PROVIDER: "scotty_worker",
    };
    resetChelCoachConfigCacheForTests();
    const without = loadChelCoachConfig(base);
    const r1 = computeReadiness(without);
    assert.ok(r1.reasons.includes("SCOTTY_WORKER_MODEL_KEY_MISSING"));
    assert.equal(r1.providerReady, false);

    setScottyProviderForTests(new ScottyWorkerProvider({ repo, modelConfigured: true }));
    const withKey = loadChelCoachConfig({ ...base, ANTHROPIC_API_KEY: "sk-ant-test-key-with-enough-length-0000" });
    const r2 = computeReadiness(withKey);
    assert.equal(r2.reasons.includes("SCOTTY_WORKER_MODEL_KEY_MISSING"), false);
    assert.equal(r2.providerReady, true);
    resetChelCoachConfigCacheForTests();
  });
});

describe("scotty worker lifecycle", () => {
  it("runs a queued job to a validated report with monotonic sequence numbers", async () => {
    await seedUpload();
    const provider = new ScottyWorkerProvider({ repo, modelConfigured: true });
    const receipt = await provider.submitAnalysis(submission());
    const sampler = new FakeSampler();
    const model = new FakeModel(true);

    const batch = await runScottyWorkerBatch({ workerId: "w1" }, { repo, sampler, model, now: () => NOW });
    assert.equal(batch.claimed, 1);
    assert.equal(batch.completed, 1);
    assert.equal(model.calls, 1);
    assert.ok(sampler.requests[0]!.length >= 6, "frames were sampled across the clip");

    const status = await provider.getJob({ externalJobId: receipt.externalJobId });
    assert.equal(status.status, "completed");
    assert.equal(status.reportReady, true);
    assert.equal(status.terminal, true);
    assert.equal(status.pollAfterMs, null);
    assert.ok((status.sequenceNumber ?? 0) >= 5, "queued → extracting → analyzing → validating → completed");

    const report = scottyReportSchema.parse(await provider.getReport({ externalJobId: receipt.externalJobId }));
    assert.equal(report.uploadId, "up-sw-1");
    assert.equal(report.jobId, receipt.externalJobId);
    assert.equal(report.playerSpecificObservations.length, 2);
    const ts = sampler.requests[0]!;
    assert.equal(report.playerSpecificObservations[0]!.timestampSec, ts[0]);
    assert.equal(report.playerSpecificObservations[1]!.timestampSec, ts[2]);
    assert.ok(report.controlGuidance.length >= 2);
    for (const g of report.controlGuidance) {
      assert.equal(g.platform, "xbox_series");
      assert.equal(g.controlScheme, "skill_stick");
      for (const step of g.inputSequence) assert.doesNotMatch(step.input, /\b(cross|circle|square|triangle|l1|r1|l2|r2)\b/i);
    }
    assert.equal(report.practiceDrills.length, 1);
    assert.ok(report.practiceDrills[0]!.verifiedControlInputs.length > 0, "drill inputs come from the knowledge table");
    assert.equal(report.qualityValidation.passed, true, JSON.stringify(report.qualityValidation));
    assert.ok(report.uncertaintyDisclosures.some((d) => d.includes("sampled at fixed intervals")));

    const stored = await repo.getByExternalJobId(receipt.externalJobId);
    assert.equal(stored?.modelUsage?.calls, 1);
    assert.equal(stored?.claimExpiresAt, undefined, "lease released");
  });

  it("drops references the model invented and records quality issues instead of failing", async () => {
    const out = goodAnalysis();
    out.observations.push({ ...out.observations[0]!, frameIndex: 99 });
    out.strategyAnalysis.requiredMechanics.push("made_up_mechanic");
    out.faceoffAnalysis = {
      faceoffCount: 2,
      wins: 2,
      losses: 1,
      detectedTechniques: ["backhand pull"],
      timingAssessment: null,
      counterSelection: null,
      postDrawResponsibility: null,
      possessionResult: null,
      strengths: [],
      improvements: [],
      confidence: "low",
    };
    const frames = [1, 10, 20, 30, 40, 50];
    const { report, issues } = assembleScottyReport({
      externalJobId: "sw_x",
      submission: submission(),
      frameTimestampsSec: frames,
      output: out,
      now: NOW,
    });
    assert.equal(report.playerSpecificObservations.length, 2);
    assert.deepEqual(report.strategyAnalysis.requiredMechanics, ["gap_control"]);
    assert.ok(report.faceoffAnalysis);
    assert.ok(report.faceoffAnalysis!.wins + report.faceoffAnalysis!.losses <= report.faceoffAnalysis!.faceoffCount);
    assert.equal(report.faceoffAnalysis!.winPercentage, 100);
    assert.equal(report.qualityValidation.passed, false);
    assert.ok(issues.length >= 3);
  });

  it("fails validation when no observation survives, and retries that as a model hiccup", async () => {
    await seedUpload();
    const provider = new ScottyWorkerProvider({ repo, modelConfigured: true, maxAttempts: 2 });
    const receipt = await provider.submitAnalysis(submission());
    const empty = () => ({ ...goodAnalysis(), observations: [] });
    const model = new FakeModel(true, empty);
    let clock = NOW;
    const deps = { repo, sampler: new FakeSampler(), model, now: () => clock };

    const first = await runScottyWorkerBatch({ workerId: "w1" }, deps);
    assert.equal(first.retried, 1);
    let job = (await repo.getByExternalJobId(receipt.externalJobId))!;
    assert.equal(job.status, "queued");
    assert.equal(job.errorCode, "REPORT_VALIDATION_FAILED");
    assert.ok(job.nextAttemptAt && new Date(job.nextAttemptAt) > clock, "backoff scheduled");

    const tooSoon = await runScottyWorkerBatch({ workerId: "w1" }, deps);
    assert.equal(tooSoon.claimed, 0, "not runnable before the backoff elapses");

    clock = new Date(NOW.getTime() + 11 * 60_000);
    const second = await runScottyWorkerBatch({ workerId: "w1" }, deps);
    assert.equal(second.failed, 1, "attempts exhausted");
    job = (await repo.getByExternalJobId(receipt.externalJobId))!;
    assert.equal(job.status, "failed");
    assert.equal(job.attemptCount, 2);
    const status = await provider.getJob({ externalJobId: receipt.externalJobId });
    assert.equal(status.terminal, true);
    assert.equal(status.errorCode, "REPORT_VALIDATION_FAILED");
  });

  it("retries a rate-limited model call and completes on the next tick", async () => {
    await seedUpload();
    const provider = new ScottyWorkerProvider({ repo, modelConfigured: true });
    const receipt = await provider.submitAnalysis(submission());
    let calls = 0;
    const model = new FakeModel(true, () => {
      calls += 1;
      return calls === 1
        ? new ProviderError("RATE_LIMITED", "busy", "rate_limit", { provider: "scotty_worker", retryable: true })
        : goodAnalysis();
    });
    let clock = NOW;
    const deps = { repo, sampler: new FakeSampler(), model, now: () => clock };
    assert.equal((await runScottyWorkerBatch({}, deps)).retried, 1);
    clock = new Date(NOW.getTime() + 60_000);
    assert.equal((await runScottyWorkerBatch({}, deps)).completed, 1);
    assert.equal((await provider.getJob({ externalJobId: receipt.externalJobId })).status, "completed");
  });

  it("fails closed without retry when the model is not configured", async () => {
    await seedUpload();
    const provider = new ScottyWorkerProvider({ repo, modelConfigured: false });
    const receipt = await provider.submitAnalysis(submission());
    const batch = await runScottyWorkerBatch({}, { repo, sampler: new FakeSampler(), model: new FakeModel(false), now: () => NOW });
    assert.equal(batch.failed, 1);
    const job = (await repo.getByExternalJobId(receipt.externalJobId))!;
    assert.equal(job.status, "failed");
    assert.equal(job.errorCode, "PROVIDER_MISCONFIGURED");
    assert.equal(job.attemptCount, 1);
  });

  it("treats a deleted source video as permanent and never calls the model", async () => {
    await seedUpload("up-sw-1", { uploadStatus: "deleted", deletedAt: NOW.toISOString() });
    const provider = new ScottyWorkerProvider({ repo, modelConfigured: true });
    const receipt = await provider.submitAnalysis(submission());
    const model = new FakeModel(true);
    await runScottyWorkerBatch({}, { repo, sampler: new FakeSampler(), model, now: () => NOW });
    const job = (await repo.getByExternalJobId(receipt.externalJobId))!;
    assert.equal(job.status, "failed");
    assert.equal(job.errorCode, "MEDIA_ALREADY_DELETED");
    assert.equal(model.calls, 0);
  });

  it("honors cancellation before and during processing", async () => {
    await seedUpload();
    const provider = new ScottyWorkerProvider({ repo, modelConfigured: true });
    const receipt = await provider.submitAnalysis(submission());
    const cancel = await provider.cancelJob({ externalJobId: receipt.externalJobId, applicationRequestId: "req-sw-1" });
    assert.equal(cancel.status, "cancelled");
    const batch = await runScottyWorkerBatch({}, { repo, sampler: new FakeSampler(), model: new FakeModel(true), now: () => NOW });
    assert.equal(batch.claimed, 0, "cancelled jobs are never claimed");
    await assert.rejects(
      () => provider.getReport({ externalJobId: receipt.externalJobId }),
      (err: unknown) => err instanceof ProviderError && err.code === "JOB_CANCELLED",
    );

    // Cancel that lands while the model call is in flight: the report is not published.
    await seedUpload("up-sw-2");
    const r2 = await provider.submitAnalysis(submission({ requestId: "req-sw-2", idempotencyKey: "idem-sw-2", uploadId: "up-sw-2", mediaTransfer: { type: "gateway_pull", uploadReference: "up-sw-2" } }));
    const racing = new FakeModel(true, () => {
      void provider.cancelJob({ externalJobId: r2.externalJobId, applicationRequestId: "req-sw-2" });
      return goodAnalysis();
    });
    const claimed = await repo.claimNext({ workerId: "w", now: NOW, leaseMs: 60_000 });
    assert.ok(claimed);
    const result = await processScottyWorkerJob(claimed!, { repo, sampler: new FakeSampler(), model: racing, now: () => NOW });
    assert.equal(result.status, "cancelled");
    const job = (await repo.getByExternalJobId(r2.externalJobId))!;
    assert.equal(job.status, "cancelled");
    assert.equal(job.report, undefined);
  });

  it("respects the tick budget and never claims work it cannot finish", async () => {
    await seedUpload();
    await seedUpload("up-sw-2");
    const provider = new ScottyWorkerProvider({ repo, modelConfigured: true });
    await provider.submitAnalysis(submission());
    await provider.submitAnalysis(submission({ requestId: "req-sw-2", idempotencyKey: "idem-sw-2", uploadId: "up-sw-2", mediaTransfer: { type: "gateway_pull", uploadReference: "up-sw-2" } }));
    const batch = await runScottyWorkerBatch({ limit: 5, budgetMs: 10_000 }, { repo, sampler: new FakeSampler(), model: new FakeModel(true), now: () => NOW });
    // 10s budget with a 10s per-job reserve: exactly one claim fits.
    assert.equal(batch.claimed, 1);
  });
});

describe("scotty worker through the application", () => {
  function xboxContext() {
    return {
      gameContext: { selectedGameTitle: "NHL 25", canonicalGameId: "nhl-25", supportStatus: "supported", mismatchState: "none" },
      playerContext: { platform: "xbox_series", controlScheme: "skill_stick", position: "C" as const, gameMode: "eashl", jerseyNumber: 17, indicatorColor: "blue", teamSide: "home" as const },
      singlePlayerControl: true,
    };
  }

  async function withServer(fn: (base: string, token: string) => Promise<void>) {
    const app = createApp();
    const server = app.listen(0);
    await new Promise<void>((r) => server.once("listening", () => r()));
    const { port } = server.address() as AddressInfo;
    const session = createOwnerSession();
    try {
      await fn(`http://127.0.0.1:${port}`, session.token);
    } finally {
      server.close();
    }
  }

  async function readyUpload(base: string, token: string): Promise<string> {
    setMediaInspectorForTests(new FakeMediaInspector({ mimeType: "video/mp4", byteSize: 2048, durationSeconds: 90, width: 640, height: 360, hasVideoStream: true }));
    const created = (await (
      await fetch(`${base}/api/uploads`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ filename: "game.mp4", contentType: "video/mp4", sizeBytes: 2048, context: xboxContext() }),
      })
    ).json()) as { uploadId: string; uploadUrl: string };
    await fetch(`${base}${created.uploadUrl}`, {
      method: "PUT",
      headers: { authorization: `Bearer ${token}`, "content-type": "video/mp4" },
      body: Buffer.alloc(2048, 7),
    });
    const ident = await fetch(`${base}/api/uploads/${created.uploadId}/player-identification`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ fixtureScenario: "high_confidence_center" }),
    });
    const identText = await ident.text();
    assert.equal(ident.status, 200, identText);
    return created.uploadId;
  }

  async function readBody<T>(res: Response, expectedStatus: number): Promise<T> {
    const text = await res.text();
    assert.equal(res.status, expectedStatus, text);
    return JSON.parse(text) as T;
  }

  beforeEach(() => {
    process.env.NODE_ENV = "test";
    process.env.CHELCOACH_FORCE_MEMORY_REPOS = "1";
    process.env.CHELCOACH_ALLOW_IDENTITY_FIXTURES = "1";
    process.env.CHELCOACH_ANALYSIS_PROVIDER = "scotty_worker";
    process.env.CHELCOACH_RECONCILE_SECRET = "worker-test-reconcile-secret";
    resetChelCoachConfigCacheForTests();
    resetSessionsForTests();
    resetUploadRepositoryForTests();
    resetProfileRepositoryForTests();
    resetMediaObjectStorageForTests();
    resetRetentionPolicyCacheForTests();
    resetIdentificationRepositoryForTests();
    resetAnalysisSubmissionRepositoryForTests();
    resetAnalysisJobRepositoryForTests();
    setConfirmationFrameExtractorForTests(new FakeConfirmationFrameExtractor());
    setScottyProviderForTests(new ScottyWorkerProvider({ repo, modelConfigured: true, pollAfterMs: 250 }));
    setFrameSamplerForTests(new FakeSampler());
    setVisionModelClientForTests(new FakeModel(true));
  });

  afterEach(() => {
    delete process.env.CHELCOACH_ANALYSIS_PROVIDER;
    delete process.env.CHELCOACH_RECONCILE_SECRET;
    resetChelCoachConfigCacheForTests();
    setMediaInspectorForTests(undefined);
  });

  it("submit → scheduler tick → poll → persisted report, end to end", async () => {
    await withServer(async (base, token) => {
      const uploadId = await readyUpload(base, token);
      const submit = await fetch(`${base}/api/uploads/${uploadId}/analysis`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      const accepted = await readBody<{ applicationRequestId: string; provider: string; status: string }>(submit, 202);
      assert.equal(accepted.provider, "scotty_worker");
      assert.equal(accepted.status, "queued");

      const before = (await (
        await fetch(`${base}/api/analysis/${accepted.applicationRequestId}`, { headers: { authorization: `Bearer ${token}` } })
      ).json()) as { status: string; reportReady: boolean };
      assert.equal(before.reportReady, false);

      const tick = await fetch(`${base}/api/internal/analysis/worker`, {
        method: "POST",
        headers: { "x-chelcoach-reconcile-secret": "worker-test-reconcile-secret", "content-type": "application/json" },
        body: JSON.stringify({ limit: 1 }),
      });
      const tickBody = await readBody<{ mode: string; completed: number }>(tick, 200);
      assert.equal(tickBody.mode, "worker");
      assert.equal(tickBody.completed, 1);

      // The application learns the outcome on the user's next *due* poll, exactly as the browser
      // poller does: keep polling on the advertised interval until the job is terminal.
      let after: { status: string; reportReady: boolean; terminal: boolean; pollAfterMs: number | null } | null = null;
      const deadline = Date.now() + 8_000;
      while (Date.now() < deadline) {
        after = (await (
          await fetch(`${base}/api/analysis/${accepted.applicationRequestId}`, { headers: { authorization: `Bearer ${token}` } })
        ).json()) as typeof after;
        if (after?.terminal) break;
        await new Promise((r) => setTimeout(r, Math.min(after?.pollAfterMs ?? 300, 500)));
      }
      assert.ok(after, "status response");
      assert.equal(after!.status, "completed", JSON.stringify(after));
      assert.equal(after!.reportReady, true);

      const reportRes = await fetch(`${base}/api/analysis/${accepted.applicationRequestId}/report`, {
        headers: { authorization: `Bearer ${token}` },
      });
      const envelope = await readBody<{ report: unknown; uploadId: string }>(reportRes, 200);
      const report = scottyReportSchema.parse(envelope.report);
      assert.equal(envelope.uploadId, uploadId);
      assert.equal(report.playerAttribution.jerseyNumber, 17);
      assert.ok(report.playerSpecificObservations.length >= 1);
    });
  });

  it("reports the tick as inactive when another provider is configured", async () => {
    process.env.CHELCOACH_ANALYSIS_PROVIDER = "fake";
    resetChelCoachConfigCacheForTests();
    await withServer(async (base) => {
      const tick = await fetch(`${base}/api/internal/analysis/worker`, {
        method: "POST",
        headers: { "x-chelcoach-reconcile-secret": "worker-test-reconcile-secret", "content-type": "application/json" },
        body: "{}",
      });
      assert.equal(tick.status, 200);
      assert.equal(((await tick.json()) as { mode: string }).mode, "inactive");
    });
  });
});
