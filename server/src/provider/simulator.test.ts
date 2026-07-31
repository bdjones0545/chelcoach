/**
 * Step 5 — Local Scotty lifecycle simulator tests (fake clock, no long sleeps).
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { AddressInfo } from "node:net";
import { readFile } from "node:fs/promises";
import { createApp } from "../app";
import { createOwnerSession, resetSessionsForTests } from "../auth/session";
import { FakeMediaInspector, setMediaInspectorForTests } from "../media/inspector";
import { resetMediaObjectStorageForTests } from "../mediaStorage";
import { resetProfileRepositoryForTests } from "../profile/repository";
import { resetRetentionPolicyCacheForTests } from "../retention/policy";
import { resetUploadRepositoryForTests } from "../uploads/repository";
import { resetIdentificationRepositoryForTests } from "../identification/repository";
import {
  setConfirmationFrameExtractorForTests,
  FakeConfirmationFrameExtractor,
} from "../identification/extractor";
import {
  loadScottyProviderConfig,
  ProviderConfigError,
} from "./config";
import {
  createScottyProvider,
  resetScottyProviderForTests,
  setScottyProviderForTests,
} from "./factory";
import { resetAnalysisJobRepositoryForTests } from "./jobs/jobRepository";
import { resetAnalysisSubmissionRepositoryForTests } from "./submissionRepository";
import { scottyAnalysisSubmissionSchema, type ScottyAnalysisSubmission } from "../scottyContract";
import { FakeClock } from "./simulator/clock";
import { deriveSimulatorJobState } from "./simulator/lifecycle";
import { buildSimulatorReport } from "./simulator/reportBuilder";
import {
  InMemorySimulatorJobRepository,
  resetSimulatorJobRepositoryForTests,
  setSimulatorJobRepositoryForTests,
} from "./simulator/repository";
import { ProviderError } from "./errors";
import { SimulatorScottyProvider } from "./simulator/simulatorProvider";
import { TEST_SIMULATOR_TIMINGS } from "./simulator/timings";
import type { SimulatorJob } from "./simulator/types";
import {
  clampPollAfterMs,
  shouldStopPolling,
  startAnalysisStatusPoller,
  statusLabel,
} from "../../../src/lib/analysisStatusPoller";

async function expectProviderCode(fn: () => Promise<unknown>, code: string) {
  await assert.rejects(fn, (err: unknown) => {
    assert.ok(err instanceof ProviderError, `expected ProviderError, got ${err}`);
    assert.equal(err.code, code);
    return true;
  });
}

function xboxSub(overrides: Partial<ScottyAnalysisSubmission> = {}): ScottyAnalysisSubmission {
  return scottyAnalysisSubmissionSchema.parse({
    requestId: "req-sim-1",
    idempotencyKey: "idem-sim-1",
    uploadId: "up-sim-1",
    ownerReference: "own-sim-1",
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
    mediaMetadata: {
      durationSec: 90,
      width: 640,
      height: 360,
      inspectedAt: new Date("2026-07-31T12:00:00.000Z").toISOString(),
    },
    mediaClassification: "short_clip",
    mediaTransfer: { type: "gateway_pull", uploadReference: "up-sim-1" },
    retentionExpiresAt: new Date("2026-08-01T12:00:00.000Z").toISOString(),
    createdAt: new Date("2026-07-31T12:00:00.000Z").toISOString(),
    ...overrides,
  });
}

function makeProvider(opts: {
  clock?: FakeClock;
  scenario?: ConstructorParameters<typeof SimulatorScottyProvider>[0] extends infer O
    ? O extends { forcedScenario?: infer S }
      ? S
      : never
    : never;
  timeoutInjection?: "none" | "submission" | "status" | "report";
  repo?: InMemorySimulatorJobRepository;
} = {}) {
  const clock = opts.clock ?? new FakeClock();
  const repo = opts.repo ?? new InMemorySimulatorJobRepository();
  setSimulatorJobRepositoryForTests(repo);
  return new SimulatorScottyProvider({
    clock,
    timings: TEST_SIMULATOR_TIMINGS,
    repo,
    forcedScenario: opts.scenario,
    timeoutInjection: opts.timeoutInjection,
  });
}

async function advanceToCompleted(
  provider: SimulatorScottyProvider,
  clock: FakeClock,
  externalJobId: string,
  requestId: string,
) {
  // Total short-clip path with TEST timings ≈ 900ms before completed.
  clock.advance(5_000);
  return provider.getJob({ externalJobId, applicationRequestId: requestId });
}

function xboxContext() {
  return {
    gameContext: {
      selectedGameTitle: "NHL 25",
      canonicalGameId: "nhl-25",
      supportStatus: "supported",
      mismatchState: "none",
    },
    playerContext: {
      platform: "xbox_series",
      controlScheme: "skill_stick",
      position: "C" as const,
      gameMode: "eashl",
      jerseyNumber: 17,
      indicatorColor: "blue",
      teamSide: "home" as const,
    },
    singlePlayerControl: true,
  };
}

async function withServer(fn: (base: string, token: string) => Promise<void>) {
  const app = createApp();
  const server = app.listen(0);
  await new Promise<void>((r) => server.once("listening", () => r()));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;
  const session = createOwnerSession();
  try {
    await fn(base, session.token);
  } finally {
    server.close();
  }
}

async function readyUpload(base: string, token: string, duration = 90): Promise<string> {
  setMediaInspectorForTests(
    new FakeMediaInspector({
      mimeType: "video/mp4",
      byteSize: 2048,
      durationSeconds: duration,
      width: 640,
      height: 360,
      hasVideoStream: true,
    }),
  );
  const created = (await (
    await fetch(`${base}/api/uploads`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        filename: "game.mp4",
        contentType: "video/mp4",
        sizeBytes: 2048,
        context: xboxContext(),
      }),
    })
  ).json()) as { uploadId: string; uploadUrl: string };
  await fetch(`${base}${created.uploadUrl}`, {
    method: "PUT",
    headers: { authorization: `Bearer ${token}`, "content-type": "video/mp4" },
    body: Buffer.alloc(2048, 7),
  });
  return created.uploadId;
}

async function identifyHighConfidence(base: string, token: string, uploadId: string) {
  const res = await fetch(`${base}/api/uploads/${uploadId}/player-identification`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ fixtureScenario: "high_confidence_center" }),
  });
  assert.equal(res.status, 200, await res.text());
}

beforeEach(() => {
  process.env.NODE_ENV = "test";
  process.env.CHELCOACH_FORCE_MEMORY_REPOS = "1";
  process.env.CHELCOACH_ALLOW_IDENTITY_FIXTURES = "1";
  process.env.CHELCOACH_ANALYSIS_PROVIDER = "fake";
  process.env.CHELCOACH_SCOTTY_SIMULATOR_ENABLED = "true";
  process.env.CHELCOACH_SCOTTIE_ENABLED = "false";
  delete process.env.SCOTTY_BASE_URL;
  delete process.env.SCOTTY_SIGNING_SECRET;
  delete process.env.CHELCOACH_SCOTTY_SIMULATOR_ALLOW_IN_PRODUCTION;
  resetSessionsForTests();
  resetUploadRepositoryForTests();
  resetProfileRepositoryForTests();
  resetMediaObjectStorageForTests();
  resetRetentionPolicyCacheForTests();
  resetIdentificationRepositoryForTests();
  resetAnalysisSubmissionRepositoryForTests();
  resetAnalysisJobRepositoryForTests();
  resetSimulatorJobRepositoryForTests();
  resetScottyProviderForTests();
  setConfirmationFrameExtractorForTests(new FakeConfirmationFrameExtractor());
});

afterEach(() => {
  resetScottyProviderForTests();
  resetSimulatorJobRepositoryForTests();
  setMediaInspectorForTests(undefined);
});

describe("simulator provider factory + config", () => {
  it("selects simulator provider", () => {
    process.env.CHELCOACH_ANALYSIS_PROVIDER = "simulator";
    process.env.NODE_ENV = "development";
    process.env.CHELCOACH_SCOTTY_SIMULATOR_ENABLED = "true";
    const p = createScottyProvider(loadScottyProviderConfig());
    assert.equal(p.mode, "simulator");
    assert.ok(p instanceof SimulatorScottyProvider);
  });

  it("blocks simulator in production by default", () => {
    process.env.CHELCOACH_ANALYSIS_PROVIDER = "simulator";
    process.env.NODE_ENV = "production";
    process.env.CHELCOACH_SCOTTY_SIMULATOR_ENABLED = "true";
    assert.throws(() => loadScottyProviderConfig(), ProviderConfigError);
  });

  it("allows simulator in production with explicit override", () => {
    process.env.CHELCOACH_ANALYSIS_PROVIDER = "simulator";
    process.env.NODE_ENV = "production";
    process.env.CHELCOACH_SCOTTY_SIMULATOR_ENABLED = "true";
    process.env.CHELCOACH_SCOTTY_SIMULATOR_ALLOW_IN_PRODUCTION = "true";
    const cfg = loadScottyProviderConfig();
    assert.equal(cfg.provider, "simulator");
  });

  it("enables simulator in development", () => {
    process.env.CHELCOACH_ANALYSIS_PROVIDER = "simulator";
    process.env.NODE_ENV = "development";
    process.env.CHELCOACH_SCOTTY_SIMULATOR_ENABLED = "true";
    const cfg = loadScottyProviderConfig();
    assert.equal(cfg.simulatorEnabled, true);
    assert.equal(createScottyProvider(cfg).mode, "simulator");
  });
});

describe("simulator lifecycle", () => {
  it("accepts submission as queued and does not return a report", async () => {
    const clock = new FakeClock();
    const provider = makeProvider({ clock, scenario: "successful_short_clip" });
    const receipt = await provider.submitAnalysis(xboxSub());
    assert.equal(receipt.status, "queued");
    assert.equal(receipt.provider, "simulator");
    await expectProviderCode(
      () => provider.getReport({ externalJobId: receipt.externalJobId }),
      "REPORT_NOT_READY",
    );
  });

  it("derives short-clip lifecycle with fake clock and sequence increments", async () => {
    const clock = new FakeClock();
    const provider = makeProvider({ clock, scenario: "successful_short_clip" });
    const receipt = await provider.submitAnalysis(xboxSub());
    const s1 = await provider.getJob({
      externalJobId: receipt.externalJobId,
      applicationRequestId: receipt.applicationRequestId,
    });
    assert.equal(s1.status, "queued");
    assert.equal(s1.sequenceNumber, 1);
    assert.equal(s1.terminal, false);
    assert.ok(s1.pollAfterMs && s1.pollAfterMs >= 200);

    clock.advance(100);
    const s2 = await provider.getJob({
      externalJobId: receipt.externalJobId,
      applicationRequestId: receipt.applicationRequestId,
    });
    assert.equal(s2.status, "inspecting_input");
    assert.equal(s2.sequenceNumber, 2);

    clock.advance(100);
    const s3 = await provider.getJob({
      externalJobId: receipt.externalJobId,
      applicationRequestId: receipt.applicationRequestId,
    });
    assert.equal(s3.status, "extracting_frames");
    assert.ok((s3.sequenceNumber ?? 0) > (s2.sequenceNumber ?? 0));

    // Repeated read is idempotent at same clock.
    const s3b = await provider.getJob({
      externalJobId: receipt.externalJobId,
      applicationRequestId: receipt.applicationRequestId,
    });
    assert.equal(s3b.status, s3.status);
    assert.equal(s3b.sequenceNumber, s3.sequenceNumber);

    const done = await advanceToCompleted(
      provider,
      clock,
      receipt.externalJobId,
      receipt.applicationRequestId,
    );
    assert.equal(done.status, "completed");
    assert.equal(done.terminal, true);
    assert.equal(done.pollAfterMs, null);
    assert.equal(done.reportReady, true);
  });

  it("uses distinct full-game lifecycle timing and bounded observations", async () => {
    const clock = new FakeClock();
    const provider = makeProvider({ clock, scenario: "successful_full_game" });
    const sub = xboxSub({
      requestId: "req-fg",
      idempotencyKey: "idem-fg",
      mediaClassification: "full_game",
      mediaMetadata: {
        durationSec: 1200,
        width: 1280,
        height: 720,
        inspectedAt: new Date("2026-07-31T12:00:00.000Z").toISOString(),
      },
    });
    const receipt = await provider.submitAnalysis(sub);
    // Analyze phase uses full-game multiplier — still active after short-clip total.
    clock.advance(700);
    const mid = await provider.getJob({
      externalJobId: receipt.externalJobId,
      applicationRequestId: receipt.applicationRequestId,
    });
    assert.notEqual(mid.status, "completed");

    clock.advance(5_000);
    const done = await provider.getJob({
      externalJobId: receipt.externalJobId,
      applicationRequestId: receipt.applicationRequestId,
    });
    assert.equal(done.status, "completed");
    const report = await provider.getReport({ externalJobId: receipt.externalJobId });
    assert.ok(report.playerSpecificObservations.length >= 8);
    assert.ok(report.playerSpecificObservations.length <= 16);
    assert.ok(report.faceoffAnalysis);
    assert.equal(
      report.faceoffAnalysis!.faceoffCount,
      report.faceoffAnalysis!.wins + report.faceoffAnalysis!.losses,
    );
    assert.ok(report.practiceDrills.length <= 3);
  });

  it("preserves effective / confirmed player context in reports", async () => {
    const clock = new FakeClock();
    const provider = makeProvider({ clock, scenario: "successful_short_clip" });
    const sub = xboxSub({
      effectivePlayer: {
        position: "RW",
        jerseyNumber: 71,
        indicatorColor: "green",
        teamSide: "away",
        confidence: 0.88,
        confidenceLabel: "high",
        source: "user_correction",
        identificationId: "id-corr",
        confirmationId: "conf-corr",
        userConfirmed: true,
      },
    });
    const receipt = await provider.submitAnalysis(sub);
    clock.advance(5_000);
    const report = await provider.getReport({ externalJobId: receipt.externalJobId });
    assert.equal(report.playerAttribution.position, "RW");
    assert.equal(report.playerAttribution.jerseyNumber, 71);
    assert.equal(report.playerAttribution.indicatorColor, "green");
    assert.equal(report.playerAttribution.confirmationState, "confirmed");
  });

  it("keeps report timestamps within media duration and rejects invalid duration", async () => {
    const clock = new FakeClock();
    const provider = makeProvider({ clock, scenario: "successful_short_clip" });
    const receipt = await provider.submitAnalysis(xboxSub());
    clock.advance(5_000);
    const report = await provider.getReport({ externalJobId: receipt.externalJobId });
    for (const o of report.playerSpecificObservations) {
      assert.ok((o.timestampSec ?? 0) <= 90);
    }

    const base = xboxSub();
    const job: SimulatorJob = {
      externalJobId: "x",
      applicationRequestId: "r",
      uploadId: "u",
      ownerReference: "o",
      idempotencyKey: "k",
      requestFingerprint: "f",
      contractVersion: "1.0.0",
      scenario: "successful_short_clip",
      acceptedAt: clock.now().toISOString(),
      submission: base,
      effectivePlayer: base.effectivePlayer,
      capabilities: base.capabilities,
      mediaClassification: "short_clip",
      mediaDurationSec: 0,
      confirmationRequired: false,
      failurePoint: null,
      lastSequenceNumber: 1,
      createdAt: clock.now().toISOString(),
      updatedAt: clock.now().toISOString(),
    };
    assert.throws(() => buildSimulatorReport({ job, now: clock.now() }), /INVALID_MEDIA_DURATION/);
  });

  it("keeps Xbox and PlayStation controls separated", async () => {
    const clock = new FakeClock();
    const xbox = makeProvider({ clock, scenario: "successful_short_clip" });
    const xboxReceipt = await xbox.submitAnalysis(xboxSub({ idempotencyKey: "idem-x", requestId: "req-x" }));
    clock.advance(5_000);
    const xboxReport = await xbox.getReport({ externalJobId: xboxReceipt.externalJobId });
    const xboxInputs = xboxReport.controlGuidance.flatMap((g) => g.inputSequence.map((s) => s.input)).join(" ");
    assert.match(xboxInputs, /\b(A|LS|RT|LT|LB|RB)\b/);
    assert.equal(/Cross|R2|Circle|Square|Triangle/i.test(xboxInputs), false);

    const clock2 = new FakeClock();
    const ps = makeProvider({ clock: clock2, scenario: "successful_short_clip" });
    const psSub = xboxSub({
      requestId: "req-ps",
      idempotencyKey: "idem-ps",
      playerContext: {
        platform: "playstation_5",
        controlScheme: "total_control",
        position: "C",
        gameMode: "eashl",
        jerseyNumber: 17,
        indicatorColor: "blue",
        teamSide: "home",
      },
    });
    const psReceipt = await ps.submitAnalysis(psSub);
    clock2.advance(5_000);
    const psReport = await ps.getReport({ externalJobId: psReceipt.externalJobId });
    const psInputs = psReport.controlGuidance.flatMap((g) => g.inputSequence.map((s) => s.input)).join(" ");
    assert.match(psInputs, /Cross|R2|Left Stick/);
    assert.equal(/\b(A|B|X|Y|RT|LT)\b/.test(psInputs), false);
  });

  it("omits faceoffs when none are represented", async () => {
    const clock = new FakeClock();
    const provider = makeProvider({ clock, scenario: "successful_short_clip" });
    const receipt = await provider.submitAnalysis(xboxSub({ idempotencyKey: "idem-noface" }));
    clock.advance(5_000);
    const report = await provider.getReport({ externalJobId: receipt.externalJobId });
    assert.equal(report.faceoffAnalysis, undefined);
  });

  it("duplicate submission returns same job; fingerprint conflict rejects", async () => {
    const provider = makeProvider({ scenario: "successful_short_clip" });
    const sub = xboxSub();
    const r1 = await provider.submitAnalysis(sub);
    const r2 = await provider.submitAnalysis(sub);
    assert.equal(r1.externalJobId, r2.externalJobId);
    await expectProviderCode(
      () =>
        provider.submitAnalysis({
          ...sub,
          effectivePlayer: { ...sub.effectivePlayer, jerseyNumber: 99 },
        }),
      "IDEMPOTENCY_CONFLICT",
    );
  });
});

describe("simulator confirmation + cancel + failures", () => {
  it("pauses for remote confirmation and resumes the same job", async () => {
    const clock = new FakeClock();
    const provider = makeProvider({ clock, scenario: "player_confirmation_required" });
    const receipt = await provider.submitAnalysis(xboxSub({ idempotencyKey: "idem-conf" }));
    clock.advance(400); // past identify
    const paused = await provider.getJob({
      externalJobId: receipt.externalJobId,
      applicationRequestId: receipt.applicationRequestId,
    });
    assert.equal(paused.status, "awaiting_player_confirmation");
    assert.equal(paused.userActionRequired, true);
    assert.equal(paused.pollAfterMs, null);
    await expectProviderCode(
      () => provider.getReport({ externalJobId: receipt.externalJobId }),
      "PLAYER_IDENTITY_UNCONFIRMED",
    );

    // Stable while paused
    clock.advance(10_000);
    const still = await provider.getJob({
      externalJobId: receipt.externalJobId,
      applicationRequestId: receipt.applicationRequestId,
    });
    assert.equal(still.status, "awaiting_player_confirmation");

    const resumed = await provider.confirmPlayer!({
      externalJobId: receipt.externalJobId,
      applicationRequestId: receipt.applicationRequestId,
      selectedCandidateId: "cand-1",
      confirmedAt: clock.now().toISOString(),
    });
    assert.notEqual(resumed.status, "awaiting_player_confirmation");
    assert.equal(resumed.applicationRequestId, receipt.applicationRequestId);

    // Idempotent confirmation
    const again = await provider.confirmPlayer!({
      externalJobId: receipt.externalJobId,
      applicationRequestId: receipt.applicationRequestId,
      selectedCandidateId: "cand-1",
      confirmedAt: clock.now().toISOString(),
    });
    assert.equal(again.jobId, resumed.jobId);

    await expectProviderCode(
      () =>
        provider.confirmPlayer!({
          externalJobId: receipt.externalJobId,
          applicationRequestId: "wrong-req",
          selectedCandidateId: "cand-1",
          confirmedAt: clock.now().toISOString(),
        }),
      "FORBIDDEN",
    );

    clock.advance(5_000);
    const done = await provider.getJob({
      externalJobId: receipt.externalJobId,
      applicationRequestId: receipt.applicationRequestId,
    });
    assert.equal(done.status, "completed");
  });

  it("cancels before/during analysis idempotently and blocks reports", async () => {
    const clock = new FakeClock();
    const provider = makeProvider({ clock, scenario: "cancel_before_analysis" });
    const receipt = await provider.submitAnalysis(xboxSub({ idempotencyKey: "idem-cancel" }));
    const c1 = await provider.cancelJob!({
      externalJobId: receipt.externalJobId,
      applicationRequestId: receipt.applicationRequestId,
      reason: "user cancel",
    });
    assert.equal(c1.status, "cancelled");
    const c2 = await provider.cancelJob!({
      externalJobId: receipt.externalJobId,
      applicationRequestId: receipt.applicationRequestId,
    });
    assert.equal(c2.status, "cancelled");
    await expectProviderCode(
      () => provider.getReport({ externalJobId: receipt.externalJobId }),
      "JOB_CANCELLED",
    );

    const clock2 = new FakeClock();
    const analyzing = makeProvider({ clock: clock2, scenario: "cancel_during_analysis" });
    const r2 = await analyzing.submitAnalysis(xboxSub({ idempotencyKey: "idem-cancel2", requestId: "req-c2" }));
    clock2.advance(600);
    const mid = await analyzing.getJob({
      externalJobId: r2.externalJobId,
      applicationRequestId: r2.applicationRequestId,
    });
    assert.ok(["analyzing_gameplay", "validating_player_identity", "extracting_frames", "identifying_controlled_player"].includes(mid.status));
    await analyzing.cancelJob!({
      externalJobId: r2.externalJobId,
      applicationRequestId: r2.applicationRequestId,
    });
    const cancelled = await analyzing.getJob({
      externalJobId: r2.externalJobId,
      applicationRequestId: r2.applicationRequestId,
    });
    assert.equal(cancelled.status, "cancelled");
  });

  it("completed jobs cannot be cancelled", async () => {
    const clock = new FakeClock();
    const provider = makeProvider({ clock, scenario: "successful_short_clip" });
    const receipt = await provider.submitAnalysis(xboxSub({ idempotencyKey: "idem-done" }));
    clock.advance(5_000);
    await provider.getJob({
      externalJobId: receipt.externalJobId,
      applicationRequestId: receipt.applicationRequestId,
    });
    await expectProviderCode(
      () =>
        provider.cancelJob!({
          externalJobId: receipt.externalJobId,
          applicationRequestId: receipt.applicationRequestId,
        }),
      "INVALID_REQUEST",
    );
  });

  it("maps inspection, analysis, validation, and timeout failures", async () => {
    for (const [scenario, code] of [
      ["provider_failure_during_inspection", "MEDIA_INSPECTION_FAILED"],
      ["provider_failure_during_analysis", "ANALYSIS_FAILED"],
      ["report_validation_failure", "REPORT_VALIDATION_FAILED"],
      ["provider_timeout", "ANALYSIS_TIMEOUT"],
    ] as const) {
      const clock = new FakeClock();
      const provider = makeProvider({ clock, scenario });
      const receipt = await provider.submitAnalysis(
        xboxSub({ idempotencyKey: `idem-${scenario}`, requestId: `req-${scenario}` }),
      );
      clock.advance(5_000);
      const status = await provider.getJob({
        externalJobId: receipt.externalJobId,
        applicationRequestId: receipt.applicationRequestId,
      });
      assert.equal(status.status, "failed", scenario);
      assert.equal(status.errorCode, code, scenario);
    }
  });

  it("supports stalled jobs and max age timeout", async () => {
    const clock = new FakeClock();
    const provider = makeProvider({ clock, scenario: "stalled_job" });
    const receipt = await provider.submitAnalysis(xboxSub({ idempotencyKey: "idem-stall" }));
    clock.advance(10_000);
    const stalled = await provider.getJob({
      externalJobId: receipt.externalJobId,
      applicationRequestId: receipt.applicationRequestId,
    });
    assert.equal(stalled.status, "analyzing_gameplay");
    assert.equal(stalled.terminal, false);
    assert.match(stalled.message ?? "", /longer than usual/i);

    clock.advance(TEST_SIMULATOR_TIMINGS.maxJobAgeMs);
    const timedOut = await provider.getJob({
      externalJobId: receipt.externalJobId,
      applicationRequestId: receipt.applicationRequestId,
    });
    assert.equal(timedOut.status, "failed");
    assert.equal(timedOut.errorCode, "ANALYSIS_TIMEOUT");
  });

  it("maps status and report retrieval timeouts", async () => {
    const provider = makeProvider({
      scenario: "successful_short_clip",
      timeoutInjection: "submission",
    });
    await assert.rejects(() => provider.submitAnalysis(xboxSub({ idempotencyKey: "idem-to-sub" })), /timed out/i);

    const clock = new FakeClock();
    const p2 = makeProvider({ clock, scenario: "successful_short_clip", timeoutInjection: "none" });
    const receipt = await p2.submitAnalysis(xboxSub({ idempotencyKey: "idem-to-status" }));
    p2.setTimeoutInjection("status");
    await assert.rejects(
      () =>
        p2.getJob({
          externalJobId: receipt.externalJobId,
          applicationRequestId: receipt.applicationRequestId,
        }),
      /status lookup timed out/i,
    );
    p2.setTimeoutInjection("report");
    await assert.rejects(() => p2.getReport({ externalJobId: receipt.externalJobId }), /report retrieval timed out/i);
  });

  it("health is healthy or degraded without exposing scenarios", async () => {
    const repo = new InMemorySimulatorJobRepository();
    const provider = makeProvider({ repo, scenario: "successful_short_clip" });
    const h1 = await provider.health!();
    assert.equal(h1.provider, "simulator");
    assert.equal(h1.reachable, true);
    assert.equal(h1.status, "healthy");
    assert.equal(JSON.stringify(h1).includes("successful_short_clip"), false);

    for (let i = 0; i < 21; i++) {
      await provider.submitAnalysis(
        xboxSub({
          idempotencyKey: `idem-h-${i}`,
          requestId: `req-h-${i}`,
          uploadId: `up-h-${i}`,
        }),
      );
    }
    const h2 = await provider.health!();
    assert.equal(h2.status, "degraded");
  });

  it("does not create per-job unmanaged timer chains", async () => {
    const src = await readFile(new URL("./simulator/simulatorProvider.ts", import.meta.url), "utf8");
    const life = await readFile(new URL("./simulator/lifecycle.ts", import.meta.url), "utf8");
    assert.equal(/setTimeout\s*\(/.test(src), false);
    assert.equal(/setTimeout\s*\(/.test(life), false);
    assert.match(life, /deriveSimulatorJobState/);
  });

  it("has no live Scotty / Cloudflare / paid model calls", async () => {
    const src = await readFile(new URL("./simulator/simulatorProvider.ts", import.meta.url), "utf8");
    assert.equal(src.includes("fetch("), false);
    assert.equal(src.includes("cloudflare"), false);
    assert.equal(src.includes("anthropic"), false);
    assert.equal(src.includes("SCOTTY_BASE_URL"), false);
  });
});

describe("application analysis status routes ownership", () => {
  it("enforces ownership on status, report, cancel, and confirmation", async () => {
    const clock = new FakeClock();
    const sim = makeProvider({ clock, scenario: "successful_short_clip" });
    setScottyProviderForTests(sim);

    await withServer(async (base, token) => {
      const uploadId = await readyUpload(base, token);
      await identifyHighConfidence(base, token, uploadId);
      const submitRes = await fetch(`${base}/api/uploads/${uploadId}/analysis`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      const accepted = (await submitRes.json()) as { applicationRequestId: string; message?: string };
      assert.equal(submitRes.status, 202, accepted.message ?? JSON.stringify(accepted));

      const other = createOwnerSession();
      const forbiddenStatus = await fetch(`${base}/api/analysis/${accepted.applicationRequestId}`, {
        headers: { authorization: `Bearer ${other.token}` },
      });
      assert.equal(forbiddenStatus.status, 403);

      const forbiddenReport = await fetch(
        `${base}/api/analysis/${accepted.applicationRequestId}/report`,
        { headers: { authorization: `Bearer ${other.token}` } },
      );
      assert.equal(forbiddenReport.status, 403);

      const forbiddenCancel = await fetch(
        `${base}/api/analysis/${accepted.applicationRequestId}/cancel`,
        {
          method: "POST",
          headers: { authorization: `Bearer ${other.token}`, "content-type": "application/json" },
          body: JSON.stringify({}),
        },
      );
      assert.equal(forbiddenCancel.status, 403);

      const forbiddenConfirm = await fetch(
        `${base}/api/analysis/${accepted.applicationRequestId}/player-confirmation`,
        {
          method: "POST",
          headers: { authorization: `Bearer ${other.token}`, "content-type": "application/json" },
          body: JSON.stringify({ selectedCandidateId: "x" }),
        },
      );
      assert.equal(forbiddenConfirm.status, 403);

      const ownStatus = await fetch(`${base}/api/analysis/${accepted.applicationRequestId}`, {
        headers: { authorization: `Bearer ${token}` },
      });
      assert.equal(ownStatus.status, 200);
      const body = (await ownStatus.json()) as { status: string; pollAfterMs: number | null };
      assert.equal(body.status, "queued");
      assert.ok(body.pollAfterMs === null || body.pollAfterMs > 0);
      assert.equal(JSON.stringify(body).includes("percent"), false);
    });
  });
});

describe("frontend minimal status poller", () => {
  it("respects pollAfterMs, stops on terminal/confirmation, aborts, avoids overlap", async () => {
    const labels = statusLabel("analyzing_gameplay");
    assert.equal(labels, "Analyzing gameplay");
    assert.equal(clampPollAfterMs(null), null);
    assert.ok((clampPollAfterMs(50) ?? 0) >= 200);
    assert.ok((clampPollAfterMs(99_999) ?? 0) <= 10_000);
    assert.equal(shouldStopPolling({ status: "completed", terminal: true, userActionRequired: false, pollAfterMs: null, reportReady: true }), true);
    assert.equal(
      shouldStopPolling({
        status: "awaiting_player_confirmation",
        terminal: false,
        userActionRequired: true,
        pollAfterMs: null,
        reportReady: false,
      }),
      true,
    );

    let calls = 0;
    let overlapping = 0;
    let inFlight = 0;
    const scheduled: Array<() => void> = [];
    const statuses = [
      {
        status: "queued",
        terminal: false,
        userActionRequired: false,
        pollAfterMs: 1000,
        reportReady: false,
      },
      {
        status: "analyzing_gameplay",
        terminal: false,
        userActionRequired: false,
        pollAfterMs: 2000,
        reportReady: false,
      },
      {
        status: "completed",
        terminal: true,
        userActionRequired: false,
        pollAfterMs: null,
        reportReady: true,
      },
    ];

    const poller = startAnalysisStatusPoller({
      fetchStatus: async () => {
        inFlight += 1;
        if (inFlight > 1) overlapping += 1;
        const next = statuses[Math.min(calls, statuses.length - 1)]!;
        calls += 1;
        inFlight -= 1;
        return next;
      },
      schedule: (fn) => {
        scheduled.push(fn);
        return { clear: () => undefined };
      },
      onStatus: () => undefined,
    });

    await Promise.resolve();
    assert.equal(calls, 1);
    scheduled.shift()?.();
    await Promise.resolve();
    assert.equal(calls, 2);
    scheduled.shift()?.();
    await Promise.resolve();
    assert.equal(calls, 3);
    // Terminal — no further schedule
    assert.equal(scheduled.length, 0);
    assert.equal(overlapping, 0);
    poller.stop();

    // Abort on unmount
    let aborted = false;
    const p2 = startAnalysisStatusPoller({
      fetchStatus: async (signal) => {
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => {
            aborted = true;
            resolve();
          });
        });
        throw new DOMException("Aborted", "AbortError");
      },
      schedule: () => ({ clear: () => undefined }),
      onStatus: () => undefined,
    });
    await Promise.resolve();
    p2.stop();
    await Promise.resolve();
    assert.equal(aborted, true);

    // Confirmation-required stops
    let confCalls = 0;
    const p3 = startAnalysisStatusPoller({
      fetchStatus: async () => {
        confCalls += 1;
        return {
          status: "awaiting_player_confirmation",
          terminal: false,
          userActionRequired: true,
          pollAfterMs: null,
          reportReady: false,
        };
      },
      schedule: (fn) => {
        scheduled.push(fn);
        return { clear: () => undefined };
      },
      onStatus: () => undefined,
    });
    await Promise.resolve();
    assert.equal(confCalls, 1);
    assert.equal(scheduled.length, 0);
    p3.stop();
  });

  it("development simulator label is gated out of production-shaped UI", async () => {
    const src = await readFile(new URL("../../../src/screens/AnalysisStatus.tsx", import.meta.url), "utf8");
    assert.match(src, /Local Scotty simulator/);
    assert.match(src, /import\.meta\.env\.DEV/);
    assert.equal(src.includes("%"), false);
    assert.equal(/progress\s*=|percentComplete|completionPercent/i.test(src), false);
  });
});

describe("deriveSimulatorJobState unit", () => {
  it("is deterministic for the same job + clock", () => {
    const now = new Date("2026-07-31T12:00:00.150Z");
    const job: SimulatorJob = {
      externalJobId: "sim_x",
      applicationRequestId: "req",
      uploadId: "up",
      ownerReference: "own",
      idempotencyKey: "idem",
      requestFingerprint: "fp",
      contractVersion: "1.0.0",
      scenario: "successful_short_clip",
      acceptedAt: "2026-07-31T12:00:00.000Z",
      submission: xboxSub(),
      effectivePlayer: xboxSub().effectivePlayer,
      capabilities: xboxSub().capabilities,
      mediaClassification: "short_clip",
      mediaDurationSec: 90,
      confirmationRequired: false,
      failurePoint: null,
      lastSequenceNumber: 1,
      createdAt: "2026-07-31T12:00:00.000Z",
      updatedAt: "2026-07-31T12:00:00.000Z",
    };
    const a = deriveSimulatorJobState(job, now, TEST_SIMULATOR_TIMINGS);
    const b = deriveSimulatorJobState(job, now, TEST_SIMULATOR_TIMINGS);
    assert.deepEqual(a, b);
    assert.equal(a.status, "inspecting_input");
  });
});
