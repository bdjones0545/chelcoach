/**
 * Vision identification — normalization of model output, the frames-first service flow, and the
 * production default that keeps fixtures out of real identification.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { AddressInfo } from "node:net";
import type {
  GameplayAnalysisModelOutput,
  IdentificationModelOutput,
  ModelUsage,
  VisionModelClient,
} from "../ai/modelClient";
import { createApp } from "../app";
import { createOwnerSession, resetSessionsForTests } from "../auth/session";
import { resetChelCoachConfigCacheForTests } from "../config/chelcoachConfig";
import { FakeMediaInspector, setMediaInspectorForTests } from "../media/inspector";
import { resetMediaObjectStorageForTests } from "../mediaStorage";
import { resetProfileRepositoryForTests } from "../profile/repository";
import { resetRetentionPolicyCacheForTests } from "../retention/policy";
import { resetUploadRepositoryForTests } from "../uploads/repository";
import {
  ClaudeVisionControlledPlayerIdentifier,
  normalizeIdentificationOutput,
  resolveIdentifierMode,
} from "./claudeVisionIdentifier";
import { FakeConfirmationFrameExtractor, setConfirmationFrameExtractorForTests } from "./extractor";
import { setControlledPlayerIdentifierForTests } from "./fixtureIdentifier";
import { resetIdentificationRepositoryForTests } from "./repository";

function usage(): ModelUsage {
  return { inputTokens: 900, outputTokens: 300, model: "claude-opus-5" };
}

function twoCandidates(): IdentificationModelOutput {
  return {
    detected: true,
    confidence: 0.86,
    predicted: { position: "C", jerseyNumber: 17, indicatorColor: "Blue", teamSide: "home" },
    uncertainties: ["Number partly occluded in frame 1"],
    candidates: [
      {
        frameIndex: 1,
        displayLabel: "Skater with blue indicator",
        boundingBox: { x: 0.4, y: 0.35, width: 0.15, height: 0.4 },
        position: "C",
        jerseyNumber: 17,
        indicatorColor: "blue",
        teamSide: "home",
        confidence: 0.86,
        evidenceSummary: "Blue ring under skates, #17 readable",
      },
      {
        frameIndex: 2,
        displayLabel: "Nearby skater",
        boundingBox: { x: 0.9, y: 0.9, width: 0.5, height: 0.5 },
        position: "RW",
        jerseyNumber: 188,
        indicatorColor: null,
        teamSide: "home",
        confidence: 0.3,
        evidenceSummary: "No indicator visible",
      },
      {
        frameIndex: 7,
        displayLabel: "Phantom",
        boundingBox: { x: 0.1, y: 0.1, width: 0.1, height: 0.1 },
        position: "LW",
        jerseyNumber: null,
        indicatorColor: null,
        teamSide: "away",
        confidence: 0.2,
        evidenceSummary: "References a frame that was not sampled",
      },
    ],
  };
}

class FakeModel implements VisionModelClient {
  constructor(
    public configured: boolean,
    private output: () => IdentificationModelOutput | Error = twoCandidates,
  ) {}
  async identifyControlledPlayer(): Promise<{ output: IdentificationModelOutput; usage: ModelUsage }> {
    const out = this.output();
    if (out instanceof Error) throw out;
    return { output: out, usage: usage() };
  }
  async analyzeGameplay(): Promise<{ output: GameplayAnalysisModelOutput; usage: ModelUsage }> {
    throw new Error("not used here");
  }
}

const frames = [{ timestampSec: 5 }, { timestampSec: 40 }, { timestampSec: 75 }];

describe("vision identification normalization", () => {
  it("ties candidates to sampled frames, bounds every field, and drops phantom references", () => {
    const r = normalizeIdentificationOutput(twoCandidates(), frames);
    assert.equal(r.detected, true);
    assert.equal(r.candidates.length, 2, "the phantom candidate is dropped");
    assert.equal(r.candidates[0]!.timestampSec, 40);
    assert.equal(r.candidates[1]!.timestampSec, 75);
    const box = r.candidates[1]!.boundingBox;
    assert.ok(box.x + box.width <= 1 && box.y + box.height <= 1, "box clamped inside the frame");
    assert.equal(r.candidates[1]!.jerseyNumber, null, "an impossible jersey number becomes null");
    assert.equal(r.indicatorColor, "blue", "colors normalized to lowercase");
    assert.ok(r.confidence <= 0.74, "several plausible skaters never auto-accept");
    assert.equal(r.confirmationRequired, true);
    assert.deepEqual(r.evidenceTimestampsSec, [5, 40, 75]);
    assert.ok(r.uncertainties.some((u) => u.includes("not sampled")));
  });

  it("keeps a single confident candidate eligible for auto-accept", () => {
    const out = twoCandidates();
    out.candidates = [out.candidates[0]!];
    const r = normalizeIdentificationOutput(out, frames);
    assert.equal(r.confidence, 0.86);
    assert.equal(r.confirmationRequired, false);
    assert.equal(r.candidates.length, 1);
  });

  it("caps confidence when nothing was detected", () => {
    const out = { ...twoCandidates(), detected: false, confidence: 0.9, candidates: [] };
    const r = normalizeIdentificationOutput(out, frames);
    assert.equal(r.detected, false);
    assert.ok(r.confidence <= 0.3);
    assert.equal(r.confirmationRequired, true);
  });
});

describe("vision identifier", () => {
  it("fails closed without credentials or frames, labelled as claude_vision", async () => {
    const noKey = new ClaudeVisionControlledPlayerIdentifier({ model: new FakeModel(false) });
    const r1 = await noKey.identify({
      uploadId: "u",
      ownerId: "o",
      gameContext: { selectedGameTitle: "NHL 25", canonicalGameId: "nhl-25", supportStatus: "supported", mismatchState: "none" },
      playerContext: { platform: "xbox_series", controlScheme: "skill_stick", position: "C", gameMode: "eashl" },
      mediaMetadata: { durationSec: 90, width: 640, height: 360, inspectedAt: new Date().toISOString() },
      frames: [{ timestampSec: 1, mimeType: "image/jpeg", width: 1, height: 1, bytes: Buffer.from([0xff, 0xd8, 0xff, 0xd9]) }],
    });
    assert.equal(r1.provider, "claude_vision");
    assert.equal(r1.failed, true);

    const withKey = new ClaudeVisionControlledPlayerIdentifier({ model: new FakeModel(true) });
    const r2 = await withKey.identify({
      uploadId: "u",
      ownerId: "o",
      gameContext: { selectedGameTitle: "NHL 25", canonicalGameId: "nhl-25", supportStatus: "supported", mismatchState: "none" },
      playerContext: { platform: "xbox_series", controlScheme: "skill_stick", position: "C", gameMode: "eashl" },
      mediaMetadata: { durationSec: 90, width: 640, height: 360, inspectedAt: new Date().toISOString() },
      frames: [],
    });
    assert.equal(r2.failed, true);
    assert.equal(withKey.requiresFrames, true);
  });

  it("defaults to claude_vision in production and fixtures elsewhere, with an explicit override", () => {
    assert.equal(resolveIdentifierMode({ NODE_ENV: "production" } as NodeJS.ProcessEnv), "claude_vision");
    assert.equal(resolveIdentifierMode({ NODE_ENV: "development" } as NodeJS.ProcessEnv), "fixture");
    assert.equal(resolveIdentifierMode({ NODE_ENV: "test" } as NodeJS.ProcessEnv), "fixture");
    assert.equal(
      resolveIdentifierMode({ NODE_ENV: "development", CHELCOACH_PLAYER_IDENTIFIER: "claude_vision" } as NodeJS.ProcessEnv),
      "claude_vision",
    );
    assert.equal(
      resolveIdentifierMode({ NODE_ENV: "production", CHELCOACH_PLAYER_IDENTIFIER: "fixture" } as NodeJS.ProcessEnv),
      "fixture",
      "an explicit operator override is honored",
    );
  });
});

describe("vision identification through the service", () => {
  function xboxContext() {
    return {
      gameContext: { selectedGameTitle: "NHL 25", canonicalGameId: "nhl-25", supportStatus: "supported", mismatchState: "none" },
      playerContext: { platform: "xbox_series", controlScheme: "skill_stick", position: "C" as const, gameMode: "eashl", jerseyNumber: 17, indicatorColor: "blue", teamSide: "home" as const },
      singlePlayerControl: true,
    };
  }

  /** Boot configures the default identifier, so the fake is installed after createApp. */
  async function withServer(
    identifier: ClaudeVisionControlledPlayerIdentifier,
    fn: (base: string, token: string) => Promise<void>,
  ) {
    const app = createApp();
    setControlledPlayerIdentifierForTests(identifier);
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

  async function readBody<T>(res: Response, expectedStatus: number): Promise<T> {
    const text = await res.text();
    assert.equal(res.status, expectedStatus, text);
    return JSON.parse(text) as T;
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
    return created.uploadId;
  }

  beforeEach(() => {
    process.env.NODE_ENV = "test";
    process.env.CHELCOACH_FORCE_MEMORY_REPOS = "1";
    process.env.CHELCOACH_ANALYSIS_PROVIDER = "fake";
    resetChelCoachConfigCacheForTests();
    resetSessionsForTests();
    resetUploadRepositoryForTests();
    resetProfileRepositoryForTests();
    resetMediaObjectStorageForTests();
    resetRetentionPolicyCacheForTests();
    resetIdentificationRepositoryForTests();
    setConfirmationFrameExtractorForTests(new FakeConfirmationFrameExtractor());
  });

  afterEach(() => {
    setControlledPlayerIdentifierForTests(undefined);
    setMediaInspectorForTests(undefined);
  });

  it("extracts frames first, so every candidate box lands on a frame the user can see", async () => {
    await withServer(new ClaudeVisionControlledPlayerIdentifier({ model: new FakeModel(true) }), async (base, token) => {
      const uploadId = await readyUpload(base, token);
      const res = await fetch(`${base}/api/uploads/${uploadId}/player-identification`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: "{}",
      });
      const body = await readBody<{
        status: string;
        frames: Array<{ frameId: string; timestampSec: number }>;
        candidates: Array<{ representativeFrameId: string; timestampSec: number; jerseyNumber: number | null }>;
      }>(res, 200);
      assert.equal(body.status, "confirmation_required");
      assert.equal(body.frames.length, 3);
      assert.equal(body.candidates.length, 2);
      const frameIds = new Set(body.frames.map((f) => f.frameId));
      for (const c of body.candidates) {
        assert.ok(frameIds.has(c.representativeFrameId), "candidate maps to an extracted frame");
        const frame = body.frames.find((f) => f.frameId === c.representativeFrameId)!;
        assert.equal(c.timestampSec, frame.timestampSec, "box timestamp is the frame's timestamp");
      }
      assert.equal(body.candidates[1]!.jerseyNumber, null);
    });
  });

  it("auto-accepts a single confident candidate as identified", async () => {
    const single = () => {
      const out = twoCandidates();
      out.candidates = [out.candidates[0]!];
      return out;
    };
    await withServer(new ClaudeVisionControlledPlayerIdentifier({ model: new FakeModel(true, single) }), async (base, token) => {
      const uploadId = await readyUpload(base, token);
      const res = await fetch(`${base}/api/uploads/${uploadId}/player-identification`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: "{}",
      });
      const body = await readBody<{ status: string; player?: { jerseyNumber: number | null } }>(res, 200);
      assert.equal(body.status, "identified");
      assert.equal(body.player?.jerseyNumber, 17);
    });
  });

  it("surfaces a model failure as an identification failure, not a fixture", async () => {
    await withServer(
      new ClaudeVisionControlledPlayerIdentifier({ model: new FakeModel(true, () => new Error("boom")) }),
      async (base, token) => {
        const uploadId = await readyUpload(base, token);
        const res = await fetch(`${base}/api/uploads/${uploadId}/player-identification`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: "{}",
        });
        const body = await readBody<{ error: string }>(res, 422);
        assert.equal(body.error, "PLAYER_IDENTIFICATION_FAILED");
      },
    );
  });
});
