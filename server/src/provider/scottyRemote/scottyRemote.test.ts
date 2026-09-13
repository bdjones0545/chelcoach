/**
 * Provider mode `scotty` against a stand-in Scottie gateway that enforces the real wire contract:
 * bearer + HMAC over "{ts}.{METHOD}.{path}.{body}", the /v1/analyze frame envelope, job polling,
 * player confirmation, and the report envelope Scottie returns. The report fixture mirrors what
 * `validator.py` + the controls/strategy/faceoff attachers emit.
 */
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fakeJpeg } from "../../media/jpegFixture";
import type { FrameSampler, SampledFrame } from "../../media/frameSampler";
import { scottyAnalysisSubmissionSchema, scottyReportSchema, type ScottyAnalysisSubmission } from "../../scottyContract";
import { getUploadRepository, resetUploadRepositoryForTests } from "../../uploads/repository";
import { ProviderError } from "../errors";
import { InMemoryScottyWorkerJobRepository } from "../scottyWorker/repository";
import { ScottieClient, signScottieRequest } from "./client";
import { ScottyRemoteProvider, loadScottyRemoteConfig } from "./provider";
import { mapScottieReport } from "./reportMapper";
import { processRemoteScottyJob, runRemoteScottyBatch } from "./worker";

const NOW = new Date("2026-09-13T01:00:00.000Z");
const API_KEY = "test-scottie-api-key-0123456789abcdef";
const SECRET = "test-scottie-signing-secret-0123456789";

function submission(overrides: Partial<ScottyAnalysisSubmission> = {}): ScottyAnalysisSubmission {
  return scottyAnalysisSubmissionSchema.parse({
    requestId: "req-sc-1",
    idempotencyKey: "idem-sc-1",
    uploadId: "up-sc-1",
    ownerReference: "own-sc-1",
    gameContext: { selectedGameTitle: "NHL 26", canonicalGameId: "nhl-26", supportStatus: "supported", mismatchState: "none" },
    playerContext: { platform: "xbox_series", controlScheme: "skill_stick", position: "C", gameMode: "eashl", jerseyNumber: 17, indicatorColor: "blue", teamSide: "home" },
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
    mediaMetadata: { durationSec: 90, width: 1280, height: 720, fps: 60, inspectedAt: NOW.toISOString() },
    mediaClassification: "short_clip",
    mediaTransfer: { type: "gateway_pull", uploadReference: "up-sc-1" },
    retentionExpiresAt: new Date(NOW.getTime() + 86_400_000).toISOString(),
    createdAt: NOW.toISOString(),
    ...overrides,
  });
}

/** A completed report as Scottie's validator + attachers produce it. */
export function scottieReportFixture(ts: number[]): Record<string, unknown> {
  const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;
  return {
    scorecard: {
      chelRating: 742,
      percentile: "Top 30%",
      overallGrade: "B",
      eventsAnalyzed: ts.length,
      gameContext: "Frame-sampled EASHL shift review.",
      metrics: [{ key: "offensive-positioning", label: "Offensive Positioning", value: 71, icon: "sports_hockey", tone: "warn", note: "n" }],
      biggestStrength: { title: "Support availability in transition", detail: "Outlet distance stays playable." },
      biggestWeakness: { title: "Strong-side over-commitment", detail: "Middle ice left light late." },
    },
    coachingMoments: [
      {
        id: "moment-1",
        type: "great",
        label: "Great Play",
        timestamp: mmss(ts[0]!),
        period: "P1",
        title: "Clean support angle",
        teaser: "Early frames show a usable support angle that keeps an outlet alive.",
        fullBreakdown: "The controlled skater's positioning relative to the puck preserves a short outlet. Keep this distance.",
        observedAction: "support positioning / outlet angle",
        attributionReason: "Blue indicator under #17",
        attributionConfidence: 0.91,
        coachingCategory: "spacing",
        execution: {
          executionAvailable: true,
          gameTitle: "NHL 26",
          platform: "xbox_series",
          controlScheme: "skill_stick",
          mechanic: "saucer_pass",
          inputs: [{ order: 0, input: "RB", behavior: "press", durationMs: null }],
          timingCue: "Lift over the stick as the lane closes",
          verified: true,
          sourceConfidence: "official",
          controlId: "nhl26-xbox-skill-saucer",
        },
      },
      {
        id: "moment-2",
        type: "breakdown",
        label: "Defensive Breakdown",
        timestamp: mmss(ts[ts.length - 1]!),
        period: "P2",
        title: "Middle-lane vacancy",
        teaser: "Late frames show middle ice opening as pressure chases strong side.",
        fullBreakdown: "Chase pressure toward the wall leaves the middle lighter; hold the middle one beat longer.",
        observedAction: "defensive middle-lane hold",
        attributionReason: "Blue indicator under #17 in the defensive zone",
        attributionConfidence: 0.8,
        coachingCategory: "defensive_positioning",
        execution: { executionAvailable: false, reason: "NO_SPECIFIC_MECHANIC", requiresUserInput: false },
      },
      {
        id: "moment-3",
        type: "missed",
        label: "Missed Opportunity",
        timestamp: "99:99", // unparseable on purpose → dropped, disclosed
        period: "P2",
        title: "Bad timestamp",
        teaser: "This one should be dropped by the mapper.",
        fullBreakdown: "Unusable timestamp from the gateway must not become an observation.",
        execution: {
          executionAvailable: true,
          platform: "playstation_5",
          controlScheme: "skill_stick",
          mechanic: "poke_check",
          inputs: [{ order: 0, input: "R1", behavior: "press" }],
          verified: true,
        },
      },
    ],
    filmRoom: {
      matchup: "Your Game",
      clipLabel: "6-frame sample",
      clipPhase: "Mixed phase",
      commentary: "The sampled frames show competent support habits mixed with occasional strong-side chase.",
      strengths: ["Outlet support distance stays playable", "Active stick posture in defensive snapshots"],
      mistakes: ["Strong-side gravity late in the sequence"],
      highestImpactAdjustment: { title: "Hold middle ice one beat longer", detail: "Delay the wall chase by one second." },
      nextGameFocus: "Win the first controlled play after each retrieval.",
      weeklySkillFocus: [{ title: "Pre-touch weak-side check", detail: "One glance before every reception." }],
      markers: [],
      impactMeters: [],
      gameSummary: [],
    },
    playerAttribution: { controlledPlayerDetected: true, confidence: 0.96, position: "C", jerseyNumber: 17, indicatorColor: "blue", identitySource: "user_confirmed", userConfirmed: true },
    practiceDrills: [
      {
        drillName: "Saucer lane reps",
        objective: "Lift passes over an active stick",
        platform: "xbox_series",
        controlScheme: "skill_stick",
        controls: [{ order: 0, input: "RB", behavior: "press" }],
        repetitions: 10,
        successCondition: "7 of 10 clean receptions",
        startingPosition: "Half-ice 2v1",
        commonMistake: "Releasing late",
        progression: "Add a passive defender",
        gameMode: "practice",
      },
    ],
    strategyAnalysis: {
      gameTitle: "NHL 26",
      gameMode: "eashl",
      position: "C",
      observedSystem: "1-2-2 Neutral Zone Trap",
      strategyId: "nz-122",
      classification: "verified",
      playerResponsibility: "Angle the carrier to the boards as F1",
      executionGrade: 72,
      strengths: ["Lane awareness"],
      improvements: [{ observation: "Late first step", strategyCategory: "neutral_zone", recommendedAdjustment: "Start the angle before the blue line", requiredMechanics: ["gap_control"], confidence: 0.7 }],
      recommendedStrategy: { strategyName: "1-2-2 Neutral Zone Trap", category: "neutral_zone" },
      knownCounters: ["Chip and chase"],
      executionControls: [],
      practiceDrill: null,
      evidenceConfidence: 0.7,
    },
    faceoffs: {
      applicable: true,
      drawsAnalyzed: 3,
      wins: 2,
      losses: 1,
      ties: 0,
      winPct: 0.667,
      executionQuality: 68,
      improvementPriorities: ["Move on the drop, not the hand"],
      events: [{ event_id: "f1", timestamp: ts[0], counter_used: "backhand pull" }],
      recommendations: [],
      drills: [],
    },
    rubricVersion: "chelcoach-rubric-v1",
  };
}

/** Minimal Scottie gateway with the real auth and lifecycle. */
class FakeScottie {
  server!: Server;
  baseUrl = "";
  jobs = new Map<string, Record<string, unknown>>();
  analyzeBodies: Array<Record<string, unknown>> = [];
  confirmations: Array<Record<string, unknown>> = [];
  /** Statuses to walk through on successive polls after dispatch. */
  script: string[] = ["analyzing_gameplay", "completed"];
  authFailures = 0;
  requireConfirmation = false;
  /** When set, POST /v1/analyze is rejected with 400 (malformed payload). */
  rejectAnalyze = false;

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        const path = (req.url ?? "/").split("?")[0]!;
        const send = (status: number, body: unknown) => {
          res.writeHead(status, { "content-type": "application/json" });
          res.end(JSON.stringify(body));
        };
        if (path === "/ready") return send(200, { ready: true, service: "scottie", provider: "xai" });
        // --- auth exactly as auth.py verifies it ---
        const auth = String(req.headers.authorization ?? "");
        if (auth !== `Bearer ${API_KEY}`) {
          this.authFailures += 1;
          return send(401, { error: "unauthorized", reason: "invalid_bearer" });
        }
        const sig = String(req.headers["x-chelcoach-signature"] ?? "");
        const m = /^t=(\d+),sha256=([0-9a-f]{64})$/.exec(sig);
        if (!m) {
          this.authFailures += 1;
          return send(401, { error: "unauthorized", reason: "missing_or_malformed_signature" });
        }
        const expected = createHmac("sha256", SECRET).update(`${m[1]}.${req.method}.${path}.`).update(raw).digest("hex");
        if (expected !== m[2]) {
          this.authFailures += 1;
          return send(401, { error: "unauthorized", reason: "signature_mismatch" });
        }
        // --- routes ---
        if (req.method === "POST" && path === "/v1/analyze") {
          const body = JSON.parse(raw) as Record<string, unknown>;
          this.analyzeBodies.push(body);
          if (this.rejectAnalyze) return send(400, { error: "malformed_payload" });
          const frames = body.frames as Array<{ timestamp: number; jpegBase64: string }>;
          if (!Array.isArray(frames) || frames.length === 0 || frames.length > 12) return send(400, { error: "malformed_payload" });
          const job = {
            jobId: String(body.jobId),
            clipId: String(body.clipId),
            status: "queued",
            stage: "queued",
            polls: 0,
            frameTs: frames.map((f) => f.timestamp),
            requiresConfirmation: this.requireConfirmation,
          };
          this.jobs.set(job.jobId, job);
          return send(202, { jobId: job.jobId, clipId: job.clipId, status: "queued", stage: "queued", phaseProgress: 0 });
        }
        const jobMatch = /^\/v1\/jobs\/([^/]+)(\/report|\/confirm-player|\/cancel)?$/.exec(path);
        if (!jobMatch) return send(404, { error: "not_found" });
        const job = this.jobs.get(decodeURIComponent(jobMatch[1]!));
        if (!job) return send(404, { error: "not_found" });
        const sub = jobMatch[2];
        if (req.method === "POST" && sub === "/confirm-player") {
          this.confirmations.push(JSON.parse(raw));
          job.requiresConfirmation = false;
          job.status = "queued";
          return send(202, { jobId: job.jobId, clipId: job.clipId, status: "queued" });
        }
        if (req.method === "POST" && sub === "/cancel") {
          job.status = "failed";
          job.errorCode = "cancelled";
          return send(200, { jobId: job.jobId, clipId: job.clipId, status: "failed", errorCode: "cancelled" });
        }
        // GET job / report: advance the script one step per poll
        if (job.status !== "completed" && job.status !== "failed") {
          if (job.requiresConfirmation) {
            job.status = "awaiting_player_confirmation";
          } else {
            const idx = Math.min(Number(job.polls), this.script.length - 1);
            job.status = this.script[idx]!;
            job.polls = Number(job.polls) + 1;
          }
        }
        const envelope: Record<string, unknown> = {
          jobId: job.jobId,
          clipId: job.clipId,
          status: job.status,
          stage: job.status,
          errorCode: job.errorCode,
          errorMessage: job.errorCode ? "failed" : undefined,
          requiresUserConfirmation: job.status === "awaiting_player_confirmation" || undefined,
        };
        if (job.status === "completed") {
          envelope.report = scottieReportFixture(job.frameTs as number[]);
          envelope.controlledPlayer = { confidence: 0.96, uncertainties: ["Jersey partly occluded at 0:05"] };
          envelope.providerMetadata = { provider: "xai", model: "grok-4", latencyMs: 12000 };
        } else if (sub === "/report") {
          return send(409, { error: "not_ready", status: job.status });
        }
        return send(200, envelope);
      });
    });
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r));
    this.baseUrl = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((r) => this.server.close(() => r()));
  }
}

class FakeSampler implements FrameSampler {
  calls = 0;
  async sample(input: { timestampsSec: number[]; maxEdge: number }): Promise<SampledFrame[]> {
    this.calls += 1;
    return input.timestampsSec.map((timestampSec) => ({
      timestampSec,
      mimeType: "image/jpeg" as const,
      width: input.maxEdge,
      height: Math.round((input.maxEdge * 9) / 16),
      bytes: fakeJpeg(input.maxEdge, Math.round((input.maxEdge * 9) / 16), 128),
    }));
  }
}

async function seedUpload(uploadId = "up-sc-1", overrides: Record<string, unknown> = {}) {
  const now = NOW.toISOString();
  await getUploadRepository().create({
    uploadId,
    ownerId: "own-sc-1",
    storageProvider: "memory",
    storageObjectKey: `chelcoach/uploads/own-sc-1/${uploadId}/source`,
    originalFilename: "game.mp4",
    displayFilename: "game.mp4",
    mimeType: "video/mp4",
    declaredByteSize: 2048,
    storedByteSize: 2048,
    trustedMedia: { durationSec: 90, width: 1280, height: 720, fps: 60, inspectedAt: now },
    mediaClassification: "short_clip",
    uploadStatus: "ready",
    context: {
      gameContext: { selectedGameTitle: "NHL 26", canonicalGameId: "nhl-26", supportStatus: "supported", mismatchState: "none" },
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

let scottie: FakeScottie;
let repo: InMemoryScottyWorkerJobRepository;
let client: ScottieClient;
let provider: ScottyRemoteProvider;

beforeEach(async () => {
  process.env.NODE_ENV = "test";
  process.env.CHELCOACH_FORCE_MEMORY_REPOS = "1";
  scottie = new FakeScottie();
  await scottie.start();
  repo = new InMemoryScottyWorkerJobRepository();
  resetUploadRepositoryForTests();
  const config = {
    baseUrl: scottie.baseUrl,
    apiKey: API_KEY,
    signingSecret: SECRET,
    statusTimeoutMs: 5_000,
    requestTimeoutMs: 10_000,
    configured: true,
  };
  client = new ScottieClient(config);
  provider = new ScottyRemoteProvider({ repo, config, client });
});

afterEach(async () => {
  await scottie.stop();
});

describe("Scottie wire contract", () => {
  it("signs exactly as the gateway verifies (canonical string {ts}.{METHOD}.{path}.{body})", () => {
    const { timestamp, signature } = signScottieRequest({ secret: SECRET, method: "post", path: "v1/analyze", rawBody: '{"a":1}', timestampMs: 1789254000000 });
    assert.equal(timestamp, "1789254000000");
    const expected = createHmac("sha256", SECRET).update("1789254000000.POST./v1/analyze.").update('{"a":1}').digest("hex");
    assert.equal(signature, `t=1789254000000,sha256=${expected}`);
  });

  it("is rejected by the gateway with the wrong secret or bearer, and reports it as misconfiguration", async () => {
    const bad = new ScottieClient({ baseUrl: scottie.baseUrl, apiKey: API_KEY, signingSecret: "wrong-secret-wrong-secret-wrong", statusTimeoutMs: 5_000, requestTimeoutMs: 5_000 });
    await assert.rejects(() => bad.getJob("nope"), (err: unknown) => err instanceof ProviderError && err.code === "PROVIDER_MISCONFIGURED");
    const badBearer = new ScottieClient({ baseUrl: scottie.baseUrl, apiKey: "not-the-key-not-the-key-000", signingSecret: SECRET, statusTimeoutMs: 5_000, requestTimeoutMs: 5_000 });
    await assert.rejects(() => badBearer.getJob("nope"), (err: unknown) => err instanceof ProviderError && err.code === "PROVIDER_MISCONFIGURED");
    assert.equal(scottie.authFailures, 2);
  });

  it("reads configuration fail-closed", () => {
    assert.equal(loadScottyRemoteConfig({}).configured, false);
    assert.equal(loadScottyRemoteConfig({ CHELCOACH_SCOTTIE_ENABLED: "true", SCOTTY_BASE_URL: "http://insecure", SCOTTY_API_KEY: API_KEY, SCOTTY_SIGNING_SECRET: SECRET }).configured, false, "https only");
    assert.equal(loadScottyRemoteConfig({ CHELCOACH_SCOTTIE_ENABLED: "true", SCOTTY_BASE_URL: "https://scottie.chelcoach.io", SCOTTY_API_KEY: API_KEY, SCOTTY_SIGNING_SECRET: SECRET }).configured, true);
    assert.equal(new ScottyRemoteProvider({ repo, config: { ...loadScottyRemoteConfig({}), configured: false } }).canServeProductionTraffic, false);
    assert.equal(provider.canServeProductionTraffic, true);
  });
});

describe("report mapping", () => {
  it("maps Scottie's report onto the contract, keeps verified controls, drops what it cannot trust", () => {
    const ts = [4, 20, 36, 52, 68, 84];
    const { report, issues } = mapScottieReport({
      externalJobId: "sc_test",
      submission: submission(),
      report: scottieReportFixture(ts),
      controlledPlayer: { confidence: 0.96, uncertainties: ["Jersey partly occluded at 0:05"] },
      providerMetadata: { model: "grok-4" },
      frameTimestampsSec: ts,
      now: NOW,
    });
    scottyReportSchema.parse(report);
    assert.equal(report.playerSpecificObservations.length, 2, "the unparseable-timestamp moment is dropped");
    assert.equal(report.playerSpecificObservations[0]!.timestampSec, 4);
    assert.equal(report.playerSpecificObservations[0]!.category, "positioning");
    assert.equal(report.playerSpecificObservations[0]!.recommendedMechanic, "saucer_pass");
    assert.equal(report.playerSpecificObservations[1]!.category, "defense");
    assert.equal(report.playerSpecificObservations[1]!.timestampSec, 84);
    assert.deepEqual(report.controlGuidance.map((g) => g.canonicalMechanic), ["saucer_pass"], "the PlayStation execution never reaches an Xbox report");
    assert.equal(report.controlGuidance[0]!.verificationStatus, "verified");
    assert.equal(report.controlGuidance[0]!.sourceConfidence, "official");
    assert.equal(report.controlGuidance[0]!.inputSequence[0]!.behavior, "tap", "press → tap");
    assert.equal(report.strategyAnalysis.strategyCategory, "neutral_zone");
    assert.equal(report.strategyAnalysis.observedStrategy, "1-2-2 Neutral Zone Trap");
    assert.deepEqual(report.strategyAnalysis.requiredMechanics, ["gap_control"]);
    assert.ok(report.faceoffAnalysis);
    assert.equal(report.faceoffAnalysis!.faceoffCount, 3);
    assert.equal(report.faceoffAnalysis!.winPercentage, 66.7);
    assert.deepEqual(report.faceoffAnalysis!.detectedTechniques, ["backhand pull"]);
    assert.equal(report.practiceDrills.length, 1);
    assert.equal(report.practiceDrills[0]!.repetitionTarget, "10 reps");
    assert.equal(report.practiceDrills[0]!.verifiedControlInputs.length, 1);
    assert.ok(report.strengths.includes("Support availability in transition"));
    assert.ok(report.priorityImprovements.includes("Hold middle ice one beat longer"));
    assert.equal(report.playerAttribution.confirmationState, "confirmed");
    assert.ok(report.uncertaintyDisclosures.some((d) => d.includes("Model: grok-4")));
    assert.ok(report.uncertaintyDisclosures.some((d) => d.includes("Jersey partly occluded")));
    assert.equal(report.reportVersion, "scottie-remote-v1");
    assert.equal(report.qualityValidation.passed, false);
    assert.ok(issues.some((i) => i.includes("dropped")));
  });

  it("synthesizes an insufficient-evidence strategy when Scottie attaches none, and fails without moments", () => {
    const ts = [4, 20];
    const base = scottieReportFixture(ts);
    delete base.strategyAnalysis;
    delete base.faceoffs;
    const { report } = mapScottieReport({ externalJobId: "x", submission: submission(), report: base, frameTimestampsSec: ts, now: NOW });
    assert.equal(report.strategyAnalysis.strategyCategory, "insufficient_evidence");
    assert.equal(report.faceoffAnalysis, undefined);
    assert.throws(
      () => mapScottieReport({ externalJobId: "x", submission: submission(), report: { ...base, coachingMoments: [] }, frameTimestampsSec: ts, now: NOW }),
      (err: unknown) => (err as { code?: string }).code === "REPORT_VALIDATION_FAILED",
    );
  });
});

describe("remote lifecycle", () => {
  it("dispatches frames, mirrors the gateway's stages, and lands a contract-valid report", async () => {
    await seedUpload();
    const receipt = await provider.submitAnalysis(submission());
    assert.equal(receipt.provider, "scotty");
    assert.equal(receipt.status, "queued");
    const sampler = new FakeSampler();
    const deps = { repo, sampler, client, now: () => NOW };

    const first = await runRemoteScottyBatch({}, deps);
    assert.equal(first.claimed, 1);
    assert.equal(sampler.calls, 1);
    assert.equal(scottie.analyzeBodies.length, 1);
    const body = scottie.analyzeBodies[0]!;
    assert.equal(body.contractVersion, "chelcoach-analysis-v1");
    assert.equal(body.rubricVersion, "chelcoach-rubric-v1");
    assert.equal(body.jobId, receipt.externalJobId);
    assert.equal(body.clipId, "up-sc-1");
    const frames = body.frames as Array<{ timestamp: number; jpegBase64: string }>;
    assert.ok(frames.length >= 6 && frames.length <= 12);
    for (let i = 1; i < frames.length; i++) assert.ok(frames[i]!.timestamp >= frames[i - 1]!.timestamp, "non-decreasing timestamps");
    const gc = body.gameplayContext as Record<string, unknown>;
    assert.equal((gc.controlledPlayer as Record<string, unknown>).jerseyNumber, 17);
    assert.equal((gc.controlledPlayer as Record<string, unknown>).userConfirmed, true);
    const meta = body.metadata as Record<string, unknown>;
    for (const v of Object.values(meta)) assert.ok(!(typeof v === "string" && /^(\/|https?:)/.test(v)), "no paths or URLs in metadata");
    let job = (await repo.getByExternalJobId(receipt.externalJobId))!;
    assert.ok(job.remote?.jobId);
    assert.equal(job.status, "inspecting_input", "gateway 'queued' is mirrored as inspecting_input, never re-dispatched");
    assert.equal(job.claimExpiresAt, undefined);

    const second = await runRemoteScottyBatch({}, deps);
    assert.equal(second.claimed, 1);
    assert.equal(scottie.analyzeBodies.length, 1, "polling never re-sends frames");
    job = (await repo.getByExternalJobId(receipt.externalJobId))!;
    assert.equal(job.status, "analyzing_gameplay");
    const seqAfterSecond = job.sequenceNumber;

    const third = await runRemoteScottyBatch({}, deps);
    assert.equal(third.completed, 1);
    job = (await repo.getByExternalJobId(receipt.externalJobId))!;
    assert.equal(job.status, "completed");
    assert.ok(job.sequenceNumber > seqAfterSecond);
    const report = scottyReportSchema.parse(await provider.getReport({ externalJobId: receipt.externalJobId }));
    assert.equal(report.jobId, receipt.externalJobId);
    assert.equal(report.uploadId, "up-sc-1");
    assert.equal(report.playerSpecificObservations[0]!.timestampSec, frames[0]!.timestamp, "timestamps refer to the frames that were sent");
    const status = await provider.getJob({ externalJobId: receipt.externalJobId });
    assert.equal(status.provider, "scotty");
    assert.equal(status.reportReady, true);
    assert.equal(status.terminal, true);

    const fourth = await runRemoteScottyBatch({}, deps);
    assert.equal(fourth.claimed, 0, "terminal jobs are never claimed again");
  });

  it("forwards ChelCoach's confirmed identity once when the gateway pauses for confirmation", async () => {
    await seedUpload();
    scottie.requireConfirmation = true;
    const receipt = await provider.submitAnalysis(submission());
    const deps = { repo, sampler: new FakeSampler(), client, now: () => NOW };
    await runRemoteScottyBatch({}, deps); // dispatch
    await runRemoteScottyBatch({}, deps); // poll → awaiting confirmation → forward identity
    assert.equal(scottie.confirmations.length, 1);
    assert.equal(scottie.confirmations[0]!.jerseyNumber, 17);
    assert.equal(scottie.confirmations[0]!.indicatorColor, "blue");
    let job = (await repo.getByExternalJobId(receipt.externalJobId))!;
    assert.equal(job.status, "validating_player_identity");
    assert.ok(job.remote?.autoConfirmedAt);
    await runRemoteScottyBatch({}, deps);
    await runRemoteScottyBatch({}, deps);
    job = (await repo.getByExternalJobId(receipt.externalJobId))!;
    assert.equal(job.status, "completed");
    assert.equal(scottie.confirmations.length, 1, "identity is forwarded exactly once");
  });

  it("mirrors a gateway failure and a gateway cancellation", async () => {
    await seedUpload();
    scottie.script = ["analyzing_gameplay"];
    const receipt = await provider.submitAnalysis(submission());
    const deps = { repo, sampler: new FakeSampler(), client, now: () => NOW };
    await runRemoteScottyBatch({}, deps);
    const remoteJob = scottie.jobs.get(receipt.externalJobId)!;
    remoteJob.status = "failed";
    remoteJob.errorCode = "invalid_report";
    await runRemoteScottyBatch({}, deps);
    const job = (await repo.getByExternalJobId(receipt.externalJobId))!;
    assert.equal(job.status, "failed");
    assert.equal(job.errorCode, "REPORT_VALIDATION_FAILED");
    await assert.rejects(() => provider.getReport({ externalJobId: receipt.externalJobId }), (err: unknown) => err instanceof ProviderError && err.code === "REPORT_VALIDATION_FAILED");

    await seedUpload("up-sc-2");
    const r2 = await provider.submitAnalysis(submission({ requestId: "req-sc-2", idempotencyKey: "idem-sc-2", uploadId: "up-sc-2", mediaTransfer: { type: "gateway_pull", uploadReference: "up-sc-2" } }));
    await runRemoteScottyBatch({}, deps);
    const cancel = await provider.cancelJob({ externalJobId: r2.externalJobId, applicationRequestId: "req-sc-2" });
    assert.equal(cancel.status, "cancelled");
    assert.equal(scottie.jobs.get(r2.externalJobId)!.errorCode, "cancelled", "the gateway job is cancelled too");
    assert.equal((await runRemoteScottyBatch({}, deps)).claimed, 0);
  });

  it("leaves a job pollable when the gateway is briefly unreachable, and fails dispatch permanently on rejection", async () => {
    await seedUpload();
    const receipt = await provider.submitAnalysis(submission());
    const deps = { repo, sampler: new FakeSampler(), client, now: () => NOW };
    await runRemoteScottyBatch({}, deps); // dispatched
    const port = (scottie.server.address() as AddressInfo).port;
    await scottie.stop();
    const down = await runRemoteScottyBatch({}, { ...deps, client: new ScottieClient({ baseUrl: `http://127.0.0.1:${port}`, apiKey: API_KEY, signingSecret: SECRET, statusTimeoutMs: 2_000, requestTimeoutMs: 2_000 }) });
    assert.equal(down.retried, 1);
    const job = (await repo.getByExternalJobId(receipt.externalJobId))!;
    assert.ok(job.remote, "dispatch state survives an outage");
    assert.equal(job.errorCode, "PROVIDER_UNAVAILABLE");
    assert.notEqual(job.status, "failed");
    scottie = new FakeScottie();
    await scottie.start();

    // A 400 from the gateway on dispatch is not retried.
    await seedUpload("up-sc-3");
    const bad = new ScottieClient({ baseUrl: scottie.baseUrl, apiKey: API_KEY, signingSecret: SECRET, statusTimeoutMs: 5_000, requestTimeoutMs: 5_000 });
    const r3 = await provider.submitAnalysis(submission({ requestId: "req-sc-3", idempotencyKey: "idem-sc-3", uploadId: "up-sc-3", mediaTransfer: { type: "gateway_pull", uploadReference: "up-sc-3" } }));
    scottie.rejectAnalyze = true;
    const row = (await repo.getByExternalJobId(r3.externalJobId))!;
    const result = await processRemoteScottyJob({ ...row, attemptCount: 1 }, { repo, sampler: new FakeSampler(), client: bad, now: () => NOW });
    assert.equal(result.status, "failed");
    assert.equal(result.errorCode, "INVALID_REQUEST");
    const failed = (await repo.getByExternalJobId(r3.externalJobId))!;
    assert.equal(failed.retryable, false);
    assert.equal(failed.remote, undefined, "a rejected dispatch never records remote state");

    // Frames that cannot be extracted are retried until the attempt budget is spent.
    const emptySampler: FrameSampler = { async sample() { return []; } };
    await seedUpload("up-sc-4");
    const r4 = await provider.submitAnalysis(submission({ requestId: "req-sc-4", idempotencyKey: "idem-sc-4", uploadId: "up-sc-4", mediaTransfer: { type: "gateway_pull", uploadReference: "up-sc-4" } }));
    const row4 = (await repo.getByExternalJobId(r4.externalJobId))!;
    const first = await processRemoteScottyJob(row4, { repo, sampler: emptySampler, client: bad, now: () => NOW });
    assert.equal(first.status, "queued");
    assert.equal(first.errorCode, "FRAME_EXTRACTION_FAILED");
    await repo.update(r4.externalJobId, { attemptCount: 3 });
    const last = await processRemoteScottyJob({ ...row4, attemptCount: 3 }, { repo, sampler: emptySampler, client: bad, now: () => NOW });
    assert.equal(last.status, "failed");
    assert.equal(last.errorCode, "FRAME_EXTRACTION_FAILED");
  });
});
