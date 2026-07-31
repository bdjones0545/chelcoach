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
import { FakeConfirmationFrameExtractor, setConfirmationFrameExtractorForTests } from "./extractor";
import { resetIdentificationRepositoryForTests } from "./repository";
import { canTransitionIdentification } from "./transitions";
import { boundingBoxSchema, MAX_PLAYER_CANDIDATES, MAX_CONFIRMATION_FRAMES } from "../scottyContract";

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
      position: "C",
      gameMode: "eashl",
      jerseyNumber: 17,
      indicatorColor: "blue",
      teamSide: "home",
    },
    singlePlayerControl: true,
  };
}

async function withServer(fn: (base: string, token: string, ownerId: string) => Promise<void>) {
  const app = createApp();
  const server = app.listen(0);
  await new Promise<void>((r) => server.once("listening", () => r()));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;
  const session = createOwnerSession();
  try {
    await fn(base, session.token, session.ownerId);
  } finally {
    server.close();
  }
}

async function readyUpload(base: string, token: string, size = 2048): Promise<string> {
  const created = (await (
    await fetch(`${base}/api/uploads`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        filename: "game.mp4",
        contentType: "video/mp4",
        sizeBytes: size,
        context: xboxContext(),
      }),
    })
  ).json()) as { uploadId: string; uploadUrl: string };

  const put = await fetch(`${base}${created.uploadUrl}`, {
    method: "PUT",
    headers: { authorization: `Bearer ${token}`, "content-type": "video/mp4" },
    body: Buffer.alloc(size, 7),
  });
  assert.equal(put.status, 200, await put.text());
  return created.uploadId;
}

beforeEach(() => {
  process.env.CHELCOACH_FORCE_MEMORY_REPOS = "1";
  process.env.NODE_ENV = "test";
  process.env.CHELCOACH_ALLOW_IDENTITY_FIXTURES = "1";
  delete process.env.CHELCOACH_PLAYER_IDENTITY_CONFIDENCE_THRESHOLD;
  resetSessionsForTests();
  resetUploadRepositoryForTests();
  resetProfileRepositoryForTests();
  resetMediaObjectStorageForTests();
  resetRetentionPolicyCacheForTests();
  resetIdentificationRepositoryForTests();
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
  setMediaInspectorForTests(undefined);
  setConfirmationFrameExtractorForTests(undefined);
  resetIdentificationRepositoryForTests();
});

describe("identification transitions", () => {
  it("allows legal transitions and rejects invalid ones", () => {
    assert.equal(canTransitionIdentification("not_started", "checking"), true);
    assert.equal(canTransitionIdentification("checking", "identified"), true);
    assert.equal(canTransitionIdentification("checking", "confirmation_required"), true);
    assert.equal(canTransitionIdentification("identified", "confirmation_required"), true);
    assert.equal(canTransitionIdentification("confirmation_required", "confirmed"), true);
    assert.equal(canTransitionIdentification("confirmed", "checking"), false);
    assert.equal(canTransitionIdentification("expired", "confirmed"), false);
    assert.equal(canTransitionIdentification("failed", "confirmed"), false);
  });
});

describe("bounding boxes", () => {
  it("accepts valid boxes and rejects invalid", () => {
    assert.ok(boundingBoxSchema.safeParse({ x: 0.1, y: 0.1, width: 0.2, height: 0.3 }).success);
    assert.equal(boundingBoxSchema.safeParse({ x: 0.9, y: 0.1, width: 0.2, height: 0.3 }).success, false);
    assert.equal(boundingBoxSchema.safeParse({ x: 0.1, y: 0.9, width: 0.2, height: 0.3 }).success, false);
  });
});

describe("player identification API", () => {
  it("ready upload can start high-confidence identification", async () => {
    await withServer(async (base, token) => {
      const uploadId = await readyUpload(base, token);
      const res = await fetch(`${base}/api/uploads/${uploadId}/player-identification`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ fixtureScenario: "high_confidence_center" }),
      });
      assert.equal(res.status, 200);
      const body = (await res.json()) as {
        status: string;
        confidence: number;
        userConfirmed: boolean;
        player?: { position: string; jerseyNumber: number };
      };
      assert.equal(body.status, "identified");
      assert.ok(body.confidence >= 0.75);
      assert.equal(body.userConfirmed, false);
      assert.equal(body.player?.position, "C");
      assert.equal(JSON.stringify(body).includes("storageObjectKey"), false);
    });
  });

  it("rejects non-ready, unauthenticated, and cross-user access", async () => {
    await withServer(async (base, token, ownerId) => {
      const pending = await (
        await fetch(`${base}/api/uploads`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify({
            filename: "p.mp4",
            contentType: "video/mp4",
            sizeBytes: 1000,
            context: xboxContext(),
          }),
        })
      ).json() as { uploadId: string };

      const notReady = await fetch(`${base}/api/uploads/${pending.uploadId}/player-identification`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ fixtureScenario: "high_confidence_center" }),
      });
      assert.equal(notReady.status, 409);

      const uploadId = await readyUpload(base, token);
      const unauth = await fetch(`${base}/api/uploads/${uploadId}/player-identification`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      assert.equal(unauth.status, 401);

      const other = createOwnerSession();
      void ownerId;
      const cross = await fetch(`${base}/api/uploads/${uploadId}/player-identification`, {
        method: "POST",
        headers: { authorization: `Bearer ${other.token}`, "content-type": "application/json" },
        body: JSON.stringify({ fixtureScenario: "high_confidence_center" }),
      });
      assert.equal(cross.status, 403);
    });
  });

  it("low-confidence returns confirmation_required with bounded candidates/frames", async () => {
    await withServer(async (base, token) => {
      const uploadId = await readyUpload(base, token);
      const res = await fetch(`${base}/api/uploads/${uploadId}/player-identification`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ fixtureScenario: "low_confidence_multiple_players" }),
      });
      assert.equal(res.status, 200);
      const body = (await res.json()) as {
        status: string;
        confidence: number;
        uncertainties: string[];
        candidates: unknown[];
        frames: { accessUrl: string; frameId: string }[];
      };
      assert.equal(body.status, "confirmation_required");
      assert.ok(body.confidence < 0.75);
      assert.ok(body.uncertainties.length > 0);
      assert.ok(body.candidates.length <= MAX_PLAYER_CANDIDATES);
      assert.ok(body.frames.length <= MAX_CONFIRMATION_FRAMES);
      assert.ok(body.frames[0]?.accessUrl.includes("/player-confirmation/frames/"));
      assert.equal(JSON.stringify(body).includes("chelcoach/uploads"), false);
    });
  });

  it("respects confidence threshold configuration", async () => {
    process.env.CHELCOACH_PLAYER_IDENTITY_CONFIDENCE_THRESHOLD = "0.99";
    resetRetentionPolicyCacheForTests();
    await withServer(async (base, token) => {
      const uploadId = await readyUpload(base, token);
      const res = await fetch(`${base}/api/uploads/${uploadId}/player-identification`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ fixtureScenario: "high_confidence_center" }),
      });
      const body = (await res.json()) as { status: string };
      // 0.93 < 0.99 → confirmation required
      assert.equal(body.status, "confirmation_required");
    });
  });

  it("identification start is idempotent", async () => {
    await withServer(async (base, token) => {
      const uploadId = await readyUpload(base, token);
      const a = await fetch(`${base}/api/uploads/${uploadId}/player-identification`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ fixtureScenario: "high_confidence_center" }),
      });
      const b = await fetch(`${base}/api/uploads/${uploadId}/player-identification`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ fixtureScenario: "low_confidence_multiple_players" }),
      });
      assert.equal(a.status, 200);
      assert.equal(b.status, 200);
      const bodyA = (await a.json()) as { identificationId: string; status: string };
      const bodyB = (await b.json()) as { identificationId: string; status: string };
      assert.equal(bodyA.identificationId, bodyB.identificationId);
      assert.equal(bodyB.status, "identified");
    });
  });

  it("confirmation persists, is idempotent, and preserves original prediction", async () => {
    await withServer(async (base, token) => {
      const uploadId = await readyUpload(base, token);
      const idRes = await fetch(`${base}/api/uploads/${uploadId}/player-identification`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ fixtureScenario: "low_confidence_multiple_players" }),
      });
      const idBody = (await idRes.json()) as {
        confidence: number;
        candidates: { candidateId: string; representativeFrameId: string; position?: string }[];
        frames: { frameId: string }[];
      };
      const cand = idBody.candidates[0]!;
      const payload = {
        uploadId,
        selectedCandidateId: cand.candidateId,
        representativeFrame: {
          frameId: cand.representativeFrameId,
          uploadId,
        },
        confirmedPosition: cand.position ?? "C",
        confirmedAt: new Date().toISOString(),
      };
      const c1 = await fetch(`${base}/api/uploads/${uploadId}/player-confirmation`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      assert.equal(c1.status, 200);
      const confirmed = (await c1.json()) as {
        status: string;
        userConfirmed: boolean;
        confirmationId: string;
        confidence: number;
      };
      assert.equal(confirmed.status, "confirmed");
      assert.equal(confirmed.userConfirmed, true);
      assert.equal(confirmed.confidence, idBody.confidence);

      const c2 = await fetch(`${base}/api/uploads/${uploadId}/player-confirmation`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      assert.equal(c2.status, 200);

      const otherCand = idBody.candidates[1]!;
      const c3 = await fetch(`${base}/api/uploads/${uploadId}/player-confirmation`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({
          ...payload,
          selectedCandidateId: otherCand.candidateId,
          representativeFrame: {
            frameId: otherCand.representativeFrameId,
            uploadId,
          },
        }),
      });
      assert.equal(c3.status, 409);
    });
  });

  it("supports high-confidence correction and none-of-the-above unresolved path", async () => {
    await withServer(async (base, token) => {
      const uploadId = await readyUpload(base, token);
      await fetch(`${base}/api/uploads/${uploadId}/player-identification`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ fixtureScenario: "high_confidence_center" }),
      });
      const corr = await fetch(`${base}/api/uploads/${uploadId}/player-confirmation/correct`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ reason: "not_my_player" }),
      });
      assert.equal(corr.status, 200);
      const corrBody = (await corr.json()) as { status: string; candidates: unknown[] };
      assert.equal(corrBody.status, "confirmation_required");
      assert.ok(corrBody.candidates.length > 0);

      const none = await fetch(`${base}/api/uploads/${uploadId}/player-confirmation/none-of-the-above`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({
          uploadId,
          requestAdditionalExtraction: true,
          hints: { jerseyNumber: 19, indicatorColor: "blue" },
        }),
      });
      assert.equal(none.status, 200);
      const noneBody = (await none.json()) as {
        status: string;
        additionalExtractionAvailable: boolean;
      };
      assert.equal(noneBody.status, "confirmation_required");
      assert.equal(noneBody.additionalExtractionAvailable, false);

      const none2 = await fetch(`${base}/api/uploads/${uploadId}/player-confirmation/none-of-the-above`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ uploadId, requestAdditionalExtraction: true }),
      });
      const unresolved = (await none2.json()) as { status: string };
      assert.equal(unresolved.status, "unresolved");
    });
  });

  it("frame endpoint requires auth, enforces ownership, hides object keys", async () => {
    await withServer(async (base, token) => {
      const uploadId = await readyUpload(base, token);
      const idRes = await fetch(`${base}/api/uploads/${uploadId}/player-identification`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ fixtureScenario: "low_confidence_multiple_players" }),
      });
      const idBody = (await idRes.json()) as { frames: { frameId: string; accessUrl: string }[] };
      const frameUrl = idBody.frames[0]!.accessUrl;

      const unauth = await fetch(`${base}${frameUrl}`);
      assert.equal(unauth.status, 401);

      const other = createOwnerSession();
      const cross = await fetch(`${base}${frameUrl}`, {
        headers: { authorization: `Bearer ${other.token}` },
      });
      assert.equal(cross.status, 403);

      const ok = await fetch(`${base}${frameUrl}`, {
        headers: { authorization: `Bearer ${token}` },
      });
      assert.equal(ok.status, 200);
      assert.equal(ok.headers.get("content-type"), "image/jpeg");
      assert.ok(Number(ok.headers.get("content-length")) > 0);
      const buf = Buffer.from(await ok.arrayBuffer());
      assert.ok(buf.length > 0);
      assert.equal(ok.headers.get("x-storage-key"), null);
    });
  });

  it("expired/deleted upload blocks confirmation; identification failure maps cleanly", async () => {
    await withServer(async (base, token) => {
      const uploadId = await readyUpload(base, token);
      const fail = await fetch(`${base}/api/uploads/${uploadId}/player-identification`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ fixtureScenario: "identification_failure" }),
      });
      assert.equal(fail.status, 422);

      const uploadId2 = await readyUpload(base, token);
      await getUploadRepository().update(uploadId2, { uploadStatus: "deleted" });
      const del = await fetch(`${base}/api/uploads/${uploadId2}/player-identification`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ fixtureScenario: "high_confidence_center" }),
      });
      assert.equal(del.status, 410);

      const uploadId3 = await readyUpload(base, token);
      await getUploadRepository().update(uploadId3, {
        expiresAt: new Date(Date.now() - 1000).toISOString(),
      });
      const exp = await fetch(`${base}/api/uploads/${uploadId3}/player-identification`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ fixtureScenario: "high_confidence_center" }),
      });
      assert.equal(exp.status, 410);
    });
  });

  it("frame extraction stays bounded and does not require full-video buffering", async () => {
    const extractor = new FakeConfirmationFrameExtractor({ maxEdge: 1280 });
    setConfirmationFrameExtractorForTests(extractor);
    await withServer(async (base, token) => {
      const uploadId = await readyUpload(base, token);
      const res = await fetch(`${base}/api/uploads/${uploadId}/player-identification`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ fixtureScenario: "low_confidence_multiple_players" }),
      });
      const body = (await res.json()) as { frames: { width: number; byteSize: number }[] };
      for (const f of body.frames) {
        assert.ok(f.width <= 1280);
        assert.ok(f.byteSize <= 500_000);
      }
    });
  });
});

describe("legacy upload path audit", () => {
  it("rejects large full-game sizes on buffered legacy init", async () => {
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/uploads/init`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          filename: "full.mp4",
          contentType: "video/mp4",
          sizeBytes: 500 * 1024 * 1024,
        }),
      });
      assert.equal(res.status, 413);
      const body = (await res.json()) as { legacy?: boolean; message: string };
      assert.equal(body.legacy, true);
      assert.match(body.message, /streamed session/i);
    });
  });

  it("Scotty upload session returns streamed content URL, not legacy /clips/:id/file", async () => {
    await withServer(async (base, token) => {
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
      ).json()) as { uploadUrl: string };
      assert.match(created.uploadUrl, /\/api\/uploads\/.+\/content$/);
      assert.equal(created.uploadUrl.includes("/clips/"), false);
      assert.equal(created.uploadUrl.endsWith("/file"), false);
    });
  });
});
