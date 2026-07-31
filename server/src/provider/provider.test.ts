import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { AddressInfo } from "node:net";
import { createApp } from "../app";
import { createOwnerSession, resetSessionsForTests } from "../auth/session";
import { FakeMediaInspector, setMediaInspectorForTests } from "../media/inspector";
import { resetMediaObjectStorageForTests } from "../mediaStorage";
import { resetProfileRepositoryForTests } from "../profile/repository";
import { resetRetentionPolicyCacheForTests } from "../retention/policy";
import { getUploadRepository, resetUploadRepositoryForTests } from "../uploads/repository";
import { resetIdentificationRepositoryForTests } from "../identification/repository";
import { setConfirmationFrameExtractorForTests, FakeConfirmationFrameExtractor } from "../identification/extractor";
import {
  loadScottyProviderConfig,
  ProviderConfigError,
} from "./config";
import { createScottyProvider, resetScottyProviderForTests, setScottyProviderForTests } from "./factory";
import { FakeScottyProvider, computeSubmissionFingerprint } from "./fakeProvider";
import { DirectAnthropicProvider } from "./directAnthropicProvider";
import { HttpScottyProvider } from "./httpScottyProvider";
import { NoopScottyRequestSigner } from "./signer";
import { classifyHttpStatus, isRetryableHttpStatus, isNonRetryableCategory } from "./retry";
import { resolveEffectivePlayerContext } from "./effectivePlayer";
import { buildIdempotencyKey, buildRequestFingerprint } from "./idempotency";
import { resetAnalysisSubmissionRepositoryForTests } from "./submissionRepository";
import { scottyCallbackEventSchema, scottyAnalysisSubmissionSchema } from "../scottyContract";
import type { PlayerIdentificationRecord } from "../identification/types";

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

async function readyUpload(base: string, token: string): Promise<string> {
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
  const put = await fetch(`${base}${created.uploadUrl}`, {
    method: "PUT",
    headers: { authorization: `Bearer ${token}`, "content-type": "video/mp4" },
    body: Buffer.alloc(2048, 7),
  });
  assert.equal(put.status, 200);
  return created.uploadId;
}

async function identify(
  base: string,
  token: string,
  uploadId: string,
  fixture: string,
): Promise<void> {
  const res = await fetch(`${base}/api/uploads/${uploadId}/player-identification`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ fixtureScenario: fixture }),
  });
  assert.ok(res.status === 200 || res.status === 422, await res.text());
}

beforeEach(() => {
  process.env.NODE_ENV = "test";
  process.env.CHELCOACH_FORCE_MEMORY_REPOS = "1";
  process.env.CHELCOACH_ALLOW_IDENTITY_FIXTURES = "1";
  process.env.CHELCOACH_ANALYSIS_PROVIDER = "fake";
  process.env.CHELCOACH_SCOTTIE_ENABLED = "false";
  delete process.env.SCOTTY_BASE_URL;
  delete process.env.SCOTTY_SIGNING_SECRET;
  delete process.env.CHELCOACH_FAKE_PROVIDER_SCENARIO;
  resetSessionsForTests();
  resetUploadRepositoryForTests();
  resetProfileRepositoryForTests();
  resetMediaObjectStorageForTests();
  resetRetentionPolicyCacheForTests();
  resetIdentificationRepositoryForTests();
  resetAnalysisSubmissionRepositoryForTests();
  resetScottyProviderForTests();
  setScottyProviderForTests(new FakeScottyProvider("accept"));
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
});

afterEach(() => {
  resetScottyProviderForTests();
  setMediaInspectorForTests(undefined);
});

describe("provider factory + config", () => {
  it("isolates Anthropic to DirectAnthropicProvider module only", async () => {
    const { readFile } = await import("node:fs/promises");
    const route = await readFile(new URL("../routes/analysis.ts", import.meta.url), "utf8");
    const service = await readFile(new URL("./submissionService.ts", import.meta.url), "utf8");
    assert.equal(route.includes("anthropic"), false);
    assert.equal(service.includes("anthropic"), false);
    assert.equal(service.includes("@anthropic"), false);
    const direct = await readFile(new URL("./directAnthropicProvider.ts", import.meta.url), "utf8");
    assert.match(direct, /DirectAnthropicProvider/);
  });

  it("selects fake provider", () => {
    const p = createScottyProvider(loadScottyProviderConfig());
    assert.equal(p.mode, "fake");
  });

  it("selects direct_anthropic when allowed outside production", () => {
    process.env.CHELCOACH_ANALYSIS_PROVIDER = "direct_anthropic";
    process.env.NODE_ENV = "development";
    const p = createScottyProvider(loadScottyProviderConfig());
    assert.equal(p.mode, "direct_anthropic");
    assert.ok(p instanceof DirectAnthropicProvider);
  });

  it("blocks direct_anthropic in production", () => {
    process.env.CHELCOACH_ANALYSIS_PROVIDER = "direct_anthropic";
    process.env.NODE_ENV = "production";
    assert.throws(() => loadScottyProviderConfig(), ProviderConfigError);
  });

  it("rejects scotty when disabled or missing URL/signing", () => {
    process.env.CHELCOACH_ANALYSIS_PROVIDER = "scotty";
    process.env.CHELCOACH_SCOTTIE_ENABLED = "false";
    assert.throws(() => loadScottyProviderConfig(), /SCOTTIE_ENABLED/);

    process.env.CHELCOACH_SCOTTIE_ENABLED = "true";
    delete process.env.SCOTTY_BASE_URL;
    assert.throws(() => loadScottyProviderConfig(), /SCOTTY_BASE_URL/);

    process.env.SCOTTY_BASE_URL = "https://example.invalid";
    delete process.env.SCOTTY_SIGNING_SECRET;
    assert.throws(() => loadScottyProviderConfig(), /SCOTTY_SIGNING_SECRET/);
  });

  it("HTTP Scotty skeleton and signer compile", async () => {
    const cfg = {
      provider: "scotty" as const,
      scottyEnabled: true,
      scottyBaseUrl: "https://example.invalid",
      contractVersion: "1.0.0",
      requestTimeoutMs: 30_000,
      statusTimeoutMs: 10_000,
      reportTimeoutMs: 30_000,
      signingSecretConfigured: false,
      nodeEnv: "test",
    };
    const http = new HttpScottyProvider(cfg, new NoopScottyRequestSigner());
    assert.equal(http.mode, "scotty");
    assert.match(http.buildEndpoint("/v1/health"), /\/v1\/health$/);
    await assert.rejects(() => http.submitAnalysis({} as never));
  });
});

describe("retry classification", () => {
  it("classifies 429/503 retryable and invalid contract non-retryable", () => {
    assert.equal(isRetryableHttpStatus(429), true);
    assert.equal(isRetryableHttpStatus(503), true);
    assert.equal(classifyHttpStatus(429), "rate_limit");
    assert.equal(classifyHttpStatus(503), "provider_unavailable");
    assert.equal(isNonRetryableCategory("contract_mismatch"), true);
    assert.equal(isNonRetryableCategory("validation"), true);
  });
});

describe("effective player + fingerprint", () => {
  const baseId: PlayerIdentificationRecord = {
    identificationId: "id-1",
    uploadId: "up-1",
    ownerId: "own-1",
    contractVersion: "1.0.0",
    status: "identified",
    detected: true,
    confidence: 0.93,
    confidenceLabel: "very_high",
    predictedPosition: "C",
    predictedJerseyNumber: 17,
    predictedIndicatorColor: "blue",
    predictedTeamSide: "home",
    evidenceTimestampsSec: [11],
    uncertainties: [],
    userConfirmed: false,
    provider: "fixture",
    additionalExtractionAttempts: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
  };

  it("uses high-confidence identification and rejects unresolved", () => {
    const ctx = xboxContext();
    const eff = resolveEffectivePlayerContext({
      uploadContext: ctx,
      identification: baseId,
    });
    assert.equal(eff.source, "high_confidence_identification");
    assert.equal(eff.jerseyNumber, 17);

    assert.throws(() =>
      resolveEffectivePlayerContext({
        uploadContext: ctx,
        identification: { ...baseId, status: "confirmation_required" },
      }),
    );
    assert.throws(() =>
      resolveEffectivePlayerContext({
        uploadContext: ctx,
        identification: { ...baseId, status: "unresolved" },
      }),
    );
  });

  it("prefers user confirmation / correction", () => {
    const ctx = xboxContext();
    const confirmed = resolveEffectivePlayerContext({
      uploadContext: ctx,
      identification: {
        ...baseId,
        status: "confirmed",
        userConfirmed: true,
        confirmationId: "conf-1",
        contextCorrection: {
          position: "RW",
          jerseyNumber: 88,
          indicatorColor: "orange",
          teamSide: "away",
          correctedAt: new Date().toISOString(),
        },
      },
      confirmation: {
        confirmationId: "conf-1",
        identificationId: "id-1",
        uploadId: "up-1",
        ownerId: "own-1",
        selectedCandidateId: "cand-1",
        selectedFrameId: "frame-1",
        confirmedPosition: "RW",
        confirmedJerseyNumber: 88,
        originalConfidence: 0.5,
        confirmedAt: new Date().toISOString(),
        source: "user",
        createdAt: new Date().toISOString(),
      },
    });
    assert.equal(confirmed.source, "user_correction");
    assert.equal(confirmed.position, "RW");
    assert.equal(confirmed.userConfirmed, true);
  });

  it("fingerprint is deterministic and excludes transient URLs", () => {
    const eff = resolveEffectivePlayerContext({
      uploadContext: xboxContext(),
      identification: baseId,
    });
    const caps = {
      identifyControlledPlayer: true,
      analyzeGameplay: true,
      analyzeStrategies: true,
      analyzeFaceoffs: true,
      includeControlGuidance: true,
      generatePracticeDrills: true,
    };
    const a = buildRequestFingerprint({
      uploadId: "up-1",
      gameContext: xboxContext().gameContext as never,
      effectivePlayer: eff,
      capabilities: caps,
      mediaClassification: "short_clip",
    });
    const b = buildRequestFingerprint({
      uploadId: "up-1",
      gameContext: xboxContext().gameContext as never,
      effectivePlayer: eff,
      capabilities: caps,
      mediaClassification: "short_clip",
    });
    assert.equal(a, b);
    assert.equal(a.includes("http"), false);

    const key1 = buildIdempotencyKey({ uploadId: "up-1", effectivePlayer: eff, capabilities: caps });
    const key2 = buildIdempotencyKey({ uploadId: "up-1", effectivePlayer: eff, capabilities: caps });
    assert.equal(key1, key2);

    const key3 = buildIdempotencyKey({
      uploadId: "up-1",
      effectivePlayer: eff,
      capabilities: { ...caps, analyzeFaceoffs: false },
    });
    assert.notEqual(key1, key3);
  });
});

describe("fake provider", () => {
  it("accepts, returns validated receipt, and is idempotent", async () => {
    const fake = new FakeScottyProvider("accept");
    const sub = scottyAnalysisSubmissionSchema.parse({
      requestId: "req-1",
      idempotencyKey: "idem-1",
      uploadId: "up-1",
      ownerReference: "own-1",
      gameContext: xboxContext().gameContext,
      playerContext: xboxContext().playerContext,
      effectivePlayer: {
        position: "C",
        jerseyNumber: 17,
        indicatorColor: "blue",
        teamSide: "home",
        confidence: 0.93,
        confidenceLabel: "very_high",
        source: "high_confidence_identification",
        identificationId: "id-1",
        userConfirmed: false,
      },
      mediaMetadata: {
        durationSec: 90,
        width: 640,
        height: 360,
        inspectedAt: new Date().toISOString(),
      },
      mediaClassification: "short_clip",
      mediaTransfer: { type: "gateway_pull", uploadReference: "up-1" },
      retentionExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
      createdAt: new Date().toISOString(),
    });
    const r1 = await fake.submitAnalysis(sub);
    assert.equal(r1.status, "queued");
    assert.equal(r1.provider, "fake");
    const r2 = await fake.submitAnalysis(sub);
    assert.equal(r1.externalJobId, r2.externalJobId);

    const conflict = { ...sub, effectivePlayer: { ...sub.effectivePlayer, jerseyNumber: 99 } };
    // Same idempotency key but different fingerprint path inside fake uses computeSubmissionFingerprint
    await assert.rejects(
      () =>
        fake.submitAnalysis({
          ...conflict,
          idempotencyKey: sub.idempotencyKey,
        }),
      /IDEMPOTENCY_CONFLICT|Idempotency/,
    );

    void computeSubmissionFingerprint(sub);
  });

  it("maps completed, failed, timeout, invalid response", async () => {
    const done = new FakeScottyProvider("completed");
    const subBase = {
      requestId: "req-2",
      idempotencyKey: "idem-2",
      uploadId: "up-2",
      ownerReference: "own-1",
      gameContext: xboxContext().gameContext,
      playerContext: xboxContext().playerContext,
      effectivePlayer: {
        position: "C" as const,
        jerseyNumber: 17,
        indicatorColor: "blue",
        teamSide: "home" as const,
        confidence: 0.93,
        confidenceLabel: "very_high" as const,
        source: "high_confidence_identification" as const,
        identificationId: "id-1",
        userConfirmed: false,
      },
      mediaMetadata: {
        durationSec: 90,
        width: 640,
        height: 360,
        inspectedAt: new Date().toISOString(),
      },
      mediaClassification: "short_clip" as const,
      mediaTransfer: { type: "gateway_pull" as const, uploadReference: "up-2" },
      retentionExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
      createdAt: new Date().toISOString(),
    };
    const receipt = await done.submitAnalysis(scottyAnalysisSubmissionSchema.parse(subBase));
    assert.equal(receipt.status, "completed");
    const report = await done.getReport({ externalJobId: receipt.externalJobId });
    assert.equal(report.uploadId, "up-2");

    const fail = new FakeScottyProvider("failed");
    await assert.rejects(() => fail.submitAnalysis(scottyAnalysisSubmissionSchema.parse({
      ...subBase,
      idempotencyKey: "idem-fail",
      requestId: "req-fail",
    })));

    const timeout = new FakeScottyProvider("timeout");
    await assert.rejects(() => timeout.submitAnalysis(scottyAnalysisSubmissionSchema.parse({
      ...subBase,
      idempotencyKey: "idem-to",
      requestId: "req-to",
    })));

    const invalid = new FakeScottyProvider("invalid_response");
    const bad = await invalid.submitAnalysis(scottyAnalysisSubmissionSchema.parse({
      ...subBase,
      idempotencyKey: "idem-bad",
      requestId: "req-bad",
    }));
    // Caller must validate — raw receipt is intentionally invalid.
    assert.equal(typeof bad.acceptedAt, "string");
  });
});

describe("analysis submission API", () => {
  it("submits when identified; rejects unresolved / expired / cross-user", async () => {
    await withServer(async (base, token) => {
      const uploadId = await readyUpload(base, token);
      await identify(base, token, uploadId, "high_confidence_center");

      const ok = await fetch(`${base}/api/uploads/${uploadId}/analysis`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      const body = (await ok.json()) as {
        applicationRequestId: string;
        status: string;
        reused: boolean;
        provider: string;
        message?: string;
      };
      assert.equal(ok.status, 202, body.message ?? JSON.stringify(body));
      assert.equal(body.provider, "fake");
      assert.equal(body.status, "queued");
      assert.equal(body.reused, false);
      assert.equal(JSON.stringify(body).includes("example.invalid"), false);
      assert.equal(JSON.stringify(body).includes("SCOTTY"), false);

      const again = await fetch(`${base}/api/uploads/${uploadId}/analysis`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      assert.equal(again.status, 202);
      const reused = (await again.json()) as { reused: boolean; applicationRequestId: string };
      assert.equal(reused.reused, true);
      assert.equal(reused.applicationRequestId, body.applicationRequestId);

      const uploadId2 = await readyUpload(base, token);
      await identify(base, token, uploadId2, "low_confidence_multiple_players");
      const unconfirmed = await fetch(`${base}/api/uploads/${uploadId2}/analysis`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      assert.equal(unconfirmed.status, 409);

      const other = createOwnerSession();
      const cross = await fetch(`${base}/api/uploads/${uploadId}/analysis`, {
        method: "POST",
        headers: { authorization: `Bearer ${other.token}`, "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      assert.equal(cross.status, 403);

      const uploadId3 = await readyUpload(base, token);
      await identify(base, token, uploadId3, "high_confidence_center");
      await getUploadRepository().update(uploadId3, {
        expiresAt: new Date(Date.now() - 1000).toISOString(),
      });
      const exp = await fetch(`${base}/api/uploads/${uploadId3}/analysis`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      assert.equal(exp.status, 410);
    });
  });

  it("rejects invalid provider response and maps timeout", async () => {
    setScottyProviderForTests(new FakeScottyProvider("invalid_response"));
    await withServer(async (base, token) => {
      const uploadId = await readyUpload(base, token);
      await identify(base, token, uploadId, "high_confidence_center");
      const res = await fetch(`${base}/api/uploads/${uploadId}/analysis`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      assert.equal(res.status, 502);
    });

    setScottyProviderForTests(new FakeScottyProvider("timeout"));
    await withServer(async (base, token) => {
      const uploadId = await readyUpload(base, token);
      await identify(base, token, uploadId, "high_confidence_center");
      const res = await fetch(`${base}/api/uploads/${uploadId}/analysis`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      assert.equal(res.status, 504);
    });
  });

  it("callback schema validates; callback route disabled by default", async () => {
    const ev = scottyCallbackEventSchema.parse({
      eventId: "ev-1",
      eventType: "job_accepted",
      externalJobId: "job-1",
      applicationRequestId: "req-1",
      status: "queued",
      occurredAt: new Date().toISOString(),
      sequenceNumber: 0,
    });
    assert.equal(ev.eventType, "job_accepted");

    await withServer(async (base) => {
      const res = await fetch(`${base}/api/internal/scotty/callbacks`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(ev),
      });
      assert.equal(res.status, 404);
    });
  });
});
