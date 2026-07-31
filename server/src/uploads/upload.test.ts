import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createApp } from "../app";
import {
  createOwnerSession,
  resetSessionsForTests,
  seedSessionForTests,
} from "../auth/session";
import { FakeMediaInspector, setMediaInspectorForTests } from "../media/inspector";
import { getMediaObjectStorage, resetMediaObjectStorageForTests } from "../mediaStorage";
import { resetProfileRepositoryForTests } from "../profile/repository";
import { resetRetentionPolicyCacheForTests } from "../retention/policy";
import { resetUploadRepositoryForTests, getUploadRepository } from "./repository";
import { expireAbandonedUploads } from "./service";
import { canTransitionUpload } from "./transitions";
import { classifyMediaDuration } from "../scottyContract";
import {
  getChelCoachConfig,
  resetChelCoachConfigCacheForTests,
} from "../config/chelcoachConfig";
import type { AddressInfo } from "node:net";
import type { MediaObjectStorage, StoredObjectMetadata } from "../mediaStorage";
import { setMediaObjectStorageForTests } from "../mediaStorage";

function xboxContext(overrides: Record<string, unknown> = {}) {
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
      jerseyNumber: 19,
      indicatorColor: "blue",
      teamSide: "home",
    },
    singlePlayerControl: true,
    ...overrides,
  };
}

async function withServer(
  fn: (base: string, token: string, ownerId: string) => Promise<void>,
): Promise<void> {
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

beforeEach(() => {
  process.env.CHELCOACH_FORCE_MEMORY_REPOS = "1";
  process.env.NODE_ENV = "test";
  delete process.env.CHELCOACH_MEDIA_STORAGE_MODE;
  delete process.env.CHELCOACH_MAX_CONCURRENT_UPLOADS_PER_USER;
  delete process.env.CHELCOACH_MAX_PENDING_UPLOADS_PER_USER;
  resetChelCoachConfigCacheForTests();
  resetSessionsForTests();
  resetUploadRepositoryForTests();
  resetProfileRepositoryForTests();
  resetMediaObjectStorageForTests();
  resetRetentionPolicyCacheForTests();
  delete process.env.CHELCOACH_MAX_UPLOAD_BYTES;
  setMediaInspectorForTests(
    new FakeMediaInspector({
      mimeType: "video/mp4",
      byteSize: 1024,
      durationSeconds: 60,
      width: 640,
      height: 360,
      hasVideoStream: true,
      videoCodec: "h264",
    }),
  );
});

afterEach(() => {
  setMediaInspectorForTests(undefined);
  resetMediaObjectStorageForTests();
  delete process.env.CHELCOACH_MEDIA_STORAGE_MODE;
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_ANON_KEY;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  resetChelCoachConfigCacheForTests();
});

describe("gameplay profile", () => {
  it("loads defaults and persists updates", async () => {
    await withServer(async (base, token) => {
      const get1 = await fetch(`${base}/api/gameplay-profile`, {
        headers: { authorization: `Bearer ${token}` },
      });
      assert.equal(get1.status, 200);
      const profile = (await get1.json()) as { preferredPlatform: string };
      assert.equal(profile.preferredPlatform, "unknown");

      const put = await fetch(`${base}/api/gameplay-profile`, {
        method: "PUT",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ preferredPlatform: "xbox_series", primaryPosition: "C" }),
      });
      assert.equal(put.status, 200);
      const updated = (await put.json()) as { preferredPlatform: string; primaryPosition: string };
      assert.equal(updated.preferredPlatform, "xbox_series");
      assert.equal(updated.primaryPosition, "C");
    });
  });

  it("upload override does not silently change defaults; saveAsDefaults does", async () => {
    await withServer(async (base, token) => {
      await fetch(`${base}/api/gameplay-profile`, {
        method: "PUT",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ preferredPlatform: "playstation_5" }),
      });

      const create = await fetch(`${base}/api/uploads`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({
          filename: "clip.mp4",
          contentType: "video/mp4",
          sizeBytes: 2048,
          context: xboxContext(),
          saveAsDefaults: false,
        }),
      });
      assert.equal(create.status, 201);

      const profile = await (
        await fetch(`${base}/api/gameplay-profile`, {
          headers: { authorization: `Bearer ${token}` },
        })
      ).json() as { preferredPlatform: string };
      assert.equal(profile.preferredPlatform, "playstation_5");

      const create2 = await fetch(`${base}/api/uploads`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({
          filename: "clip2.mp4",
          contentType: "video/mp4",
          sizeBytes: 2048,
          context: xboxContext(),
          saveAsDefaults: true,
        }),
      });
      assert.equal(create2.status, 201);
      const profile2 = await (
        await fetch(`${base}/api/gameplay-profile`, {
          headers: { authorization: `Bearer ${token}` },
        })
      ).json() as { preferredPlatform: string; primaryPosition: string };
      assert.equal(profile2.preferredPlatform, "xbox_series");
      assert.equal(profile2.primaryPosition, "C");
    });
  });
});

describe("upload session auth + ownership", () => {
  it("rejects unauthenticated upload creation", async () => {
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/uploads`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          filename: "a.mp4",
          contentType: "video/mp4",
          sizeBytes: 100,
          context: xboxContext(),
        }),
      });
      assert.equal(res.status, 401);
    });
  });

  it("rejects cross-user access", async () => {
    await withServer(async (base, token) => {
      const created = await (
        await fetch(`${base}/api/uploads`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify({
            filename: "a.mp4",
            contentType: "video/mp4",
            sizeBytes: 100,
            context: xboxContext(),
          }),
        })
      ).json() as { uploadId: string };

      const other = createOwnerSession();
      seedSessionForTests(other);
      const denied = await fetch(`${base}/api/uploads/${created.uploadId}`, {
        headers: { authorization: `Bearer ${other.token}` },
      });
      assert.equal(denied.status, 403);
    });
  });
});

describe("game support + platform context", () => {
  it("accepts supported game and valid Xbox/PlayStation contexts", async () => {
    await withServer(async (base, token) => {
      const xbox = await fetch(`${base}/api/uploads`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({
          filename: "x.mp4",
          contentType: "video/mp4",
          sizeBytes: 100,
          context: xboxContext(),
        }),
      });
      assert.equal(xbox.status, 201);

      const ps = await fetch(`${base}/api/uploads`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({
          filename: "p.mp4",
          contentType: "video/mp4",
          sizeBytes: 100,
          context: {
            ...xboxContext(),
            playerContext: {
              platform: "playstation_5",
              controlScheme: "total_control",
              position: "LW",
              gameMode: "online_versus",
              jerseyNumber: 88,
              indicatorColor: "orange",
            },
          },
        }),
      });
      assert.equal(ps.status, 201);
    });
  });

  it("rejects unsupported and released-not-supported games", async () => {
    await withServer(async (base, token) => {
      const unsupported = await fetch(`${base}/api/uploads`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({
          filename: "a.mp4",
          contentType: "video/mp4",
          sizeBytes: 100,
          context: xboxContext({
            gameContext: {
              selectedGameTitle: "Fake",
              canonicalGameId: "nhl-99",
              supportStatus: "supported",
              mismatchState: "none",
            },
          }),
        }),
      });
      assert.equal(unsupported.status, 422);

      const notYet = await fetch(`${base}/api/uploads`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({
          filename: "a.mp4",
          contentType: "video/mp4",
          sizeBytes: 100,
          context: xboxContext({
            gameContext: {
              selectedGameTitle: "NHL 26",
              canonicalGameId: "nhl-26",
              supportStatus: "supported",
              mismatchState: "none",
            },
          }),
        }),
      });
      assert.equal(notYet.status, 422);
      const body = (await notYet.json()) as { error: string };
      assert.equal(body.error, "GAME_NOT_YET_SUPPORTED");
    });
  });
});

describe("media classification + duration", () => {
  it("classifies short / extended / full-game and enforces 1800s", () => {
    assert.equal(classifyMediaDuration(60), "short_clip");
    assert.equal(classifyMediaDuration(120), "short_clip");
    assert.equal(classifyMediaDuration(121), "extended_clip");
    assert.equal(classifyMediaDuration(899), "extended_clip");
    assert.equal(classifyMediaDuration(900), "full_game");
    assert.equal(classifyMediaDuration(1800), "full_game");
    assert.throws(() => classifyMediaDuration(1801));
  });

  it("trusted duration overrides client duration; rejects over max", async () => {
    setMediaInspectorForTests(
      new FakeMediaInspector({
        mimeType: "video/mp4",
        byteSize: 2048,
        durationSeconds: 1801,
        width: 640,
        height: 360,
        hasVideoStream: true,
      }),
    );
    await withServer(async (base, token) => {
      const created = await (
        await fetch(`${base}/api/uploads`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify({
            filename: "long.mp4",
            contentType: "video/mp4",
            sizeBytes: 2048,
            clientDeclaredDurationSec: 60,
            context: xboxContext(),
          }),
        })
      ).json() as { uploadId: string; uploadUrl: string };

      const put = await fetch(`${base}${created.uploadUrl}`, {
        method: "PUT",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "video/mp4",
        },
        body: Buffer.alloc(2048, 7),
      });
      assert.equal(put.status, 422);
      const err = (await put.json()) as { error: string };
      assert.equal(err.error, "VIDEO_DURATION_EXCEEDED");
    });
  });

  it("streams upload and returns ready classification without exposing storage keys", async () => {
    setMediaInspectorForTests(
      new FakeMediaInspector({
        mimeType: "video/mp4",
        byteSize: 4096,
        durationSeconds: 950,
        width: 1280,
        height: 720,
        hasVideoStream: true,
      }),
    );
    await withServer(async (base, token) => {
      const created = await (
        await fetch(`${base}/api/uploads`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify({
            filename: "game.mp4",
            contentType: "video/mp4",
            sizeBytes: 4096,
            context: xboxContext(),
          }),
        })
      ).json() as { uploadId: string; uploadUrl: string };

      const put = await fetch(`${base}${created.uploadUrl}`, {
        method: "PUT",
        headers: { authorization: `Bearer ${token}`, "content-type": "video/mp4" },
        body: Buffer.alloc(4096, 1),
      });
      assert.equal(put.status, 200);
      const detail = (await put.json()) as {
        uploadStatus: string;
        mediaClassification: string;
        durationSec: number;
      };
      assert.equal(detail.uploadStatus, "ready");
      assert.equal(detail.mediaClassification, "full_game");
      assert.equal(detail.durationSec, 950);
      assert.equal(JSON.stringify(detail).includes("storageObjectKey"), false);
      assert.equal(JSON.stringify(detail).includes("chelcoach/uploads"), false);

      const internal = await getUploadRepository().get(created.uploadId);
      assert.ok(internal?.storageObjectKey.startsWith("chelcoach/uploads/"));
      assert.ok(internal?.trustedMedia);
      assert.ok(internal?.expiresAt);
      assert.ok(internal?.absoluteDeleteAt);
    });
  });
});

describe("byte limits + streaming safety", () => {
  it("enforces configured byte limit and deletes partials", async () => {
    process.env.CHELCOACH_MAX_UPLOAD_BYTES = String(1_000_000);
    resetRetentionPolicyCacheForTests();
    await withServer(async (base, token) => {
      const created = await (
        await fetch(`${base}/api/uploads`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify({
            filename: "big.mp4",
            contentType: "video/mp4",
            sizeBytes: 500_000,
            context: xboxContext(),
          }),
        })
      ).json() as { uploadId: string; uploadUrl: string };
      assert.ok(created.uploadUrl, "upload session created");

      const put = await fetch(`${base}${created.uploadUrl}`, {
        method: "PUT",
        headers: { authorization: `Bearer ${token}`, "content-type": "video/mp4" },
        body: Buffer.alloc(1_200_000, 9),
      });
      assert.equal(put.status, 413);
      const rec = await getUploadRepository().get(created.uploadId);
      assert.equal(rec?.uploadStatus, "expired");
      assert.equal(await getMediaObjectStorage().exists(rec!.storageObjectKey), false);
    });
  });

  it("does not allocate a single full-file Buffer in the streaming storage path", async () => {
    // Instrument: write handle finalize stores on disk; RSS should not grow by payload size.
    const payload = Buffer.alloc(5 * 1024 * 1024, 3); // 5 MiB
    setMediaInspectorForTests(
      new FakeMediaInspector({
        mimeType: "video/mp4",
        byteSize: payload.length,
        durationSeconds: 30,
        width: 320,
        height: 240,
        hasVideoStream: true,
      }),
    );
    await withServer(async (base, token) => {
      const before = process.memoryUsage().heapUsed;
      const created = await (
        await fetch(`${base}/api/uploads`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify({
            filename: "mem.mp4",
            contentType: "video/mp4",
            sizeBytes: payload.length,
            context: xboxContext(),
          }),
        })
      ).json() as { uploadUrl: string };

      const put = await fetch(`${base}${created.uploadUrl}`, {
        method: "PUT",
        headers: { authorization: `Bearer ${token}`, "content-type": "video/mp4" },
        body: payload,
      });
      assert.equal(put.status, 200);
      const after = process.memoryUsage().heapUsed;
      const delta = after - before;
      // Heap growth must stay well below the payload size (streamed to disk).
      assert.ok(
        delta < payload.length * 0.75,
        `heap grew by ${delta} for payload ${payload.length}`,
      );
    });
  });
});

describe("status transitions + cleanup", () => {
  it("allows valid transitions and rejects deleted→ready", () => {
    assert.equal(canTransitionUpload("pending", "uploading"), true);
    assert.equal(canTransitionUpload("uploaded", "processing"), true);
    assert.equal(canTransitionUpload("processing", "ready"), true);
    assert.equal(canTransitionUpload("deleted", "ready"), false);
  });

  it("cancels upload and expires abandoned pending sessions", async () => {
    await withServer(async (base, token) => {
      const created = await (
        await fetch(`${base}/api/uploads`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify({
            filename: "c.mp4",
            contentType: "video/mp4",
            sizeBytes: 100,
            context: xboxContext(),
          }),
        })
      ).json() as { uploadId: string };

      const del = await fetch(`${base}/api/uploads/${created.uploadId}`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${token}` },
      });
      assert.equal(del.status, 200);
      const body = (await del.json()) as { uploadStatus: string };
      assert.equal(body.uploadStatus, "expired");

      // Abandoned pending expiration
      const pending = await (
        await fetch(`${base}/api/uploads`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify({
            filename: "old.mp4",
            contentType: "video/mp4",
            sizeBytes: 100,
            context: xboxContext(),
          }),
        })
      ).json() as { uploadId: string };
      await getUploadRepository().update(pending.uploadId, {
        pendingExpiresAt: new Date(Date.now() - 1000).toISOString(),
      });
      const n = await expireAbandonedUploads(new Date());
      assert.ok(n >= 1);
      const rec = await getUploadRepository().get(pending.uploadId);
      assert.equal(rec?.uploadStatus, "expired");
    });
  });

  it("rejects missing storage object on complete", async () => {
    await withServer(async (base, token) => {
      const created = await (
        await fetch(`${base}/api/uploads`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify({
            filename: "m.mp4",
            contentType: "video/mp4",
            sizeBytes: 100,
            context: xboxContext(),
          }),
        })
      ).json() as { uploadId: string };

      await getUploadRepository().update(created.uploadId, { uploadStatus: "uploaded" });
      const complete = await fetch(`${base}/api/uploads/${created.uploadId}/complete`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
      });
      assert.equal(complete.status, 404);
    });
  });
});

describe("inspection failures + MIME", () => {
  it("maps media inspection failure", async () => {
    setMediaInspectorForTests(
      new FakeMediaInspector(async () => {
        throw Object.assign(new Error("boom"), { code: "MEDIA_INSPECTION_FAILED" });
      }),
    );
    await withServer(async (base, token) => {
      const created = await (
        await fetch(`${base}/api/uploads`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify({
            filename: "bad.mp4",
            contentType: "video/mp4",
            sizeBytes: 128,
            context: xboxContext(),
          }),
        })
      ).json() as { uploadUrl: string };

      const put = await fetch(`${base}${created.uploadUrl}`, {
        method: "PUT",
        headers: { authorization: `Bearer ${token}`, "content-type": "video/mp4" },
        body: Buffer.alloc(128, 2),
      });
      assert.equal(put.status, 422);
    });
  });

  it("rejects unsupported MIME at creation", async () => {
    await withServer(async (base, token) => {
      const res = await fetch(`${base}/api/uploads`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({
          filename: "a.avi",
          contentType: "video/x-msvideo",
          sizeBytes: 100,
          context: xboxContext(),
        }),
      });
      assert.equal(res.status, 400);
    });
  });
});

describe("supabase_storage upload session", () => {
  it("returns resumable session and blocks server-stream PUT", async () => {
    process.env.CHELCOACH_MEDIA_STORAGE_MODE = "supabase_storage";
    process.env.SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_ANON_KEY = "anon-test";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-test";
    resetChelCoachConfigCacheForTests();
    assert.equal(getChelCoachConfig().storage.mode, "supabase_storage");

    const fake: MediaObjectStorage = {
      backend: "supabase",
      createObjectKey(ownerId, uploadId) {
        return `${ownerId}/${uploadId}/source`;
      },
      async openWriteStream() {
        throw Object.assign(new Error("STORAGE_UPLOAD_FAILED"), { code: "STORAGE_UPLOAD_FAILED" });
      },
      async statObject(objectKey): Promise<StoredObjectMetadata> {
        return {
          objectKey,
          byteSize: 128,
          contentType: "video/mp4",
          exists: true,
        };
      },
      async openReadStream() {
        return Readable.from(Buffer.alloc(128));
      },
      async deleteObject() {
        return { deleted: true, alreadyAbsent: false };
      },
      async exists() {
        return true;
      },
    };
    setMediaObjectStorageForTests(fake);

    await withServer(async (base, token, ownerId) => {
      const create = await fetch(`${base}/api/uploads`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({
          filename: "gameplay.mp4",
          contentType: "video/mp4",
          sizeBytes: 128,
          context: xboxContext(),
        }),
      });
      assert.equal(create.status, 201);
      const session = (await create.json()) as {
        uploadId: string;
        transport: string;
        bucket: string;
        objectPath: string;
        resumableEndpoint: string;
        uploadUrl: string;
      };
      assert.equal(session.transport, "supabase_resumable");
      assert.equal(session.bucket, "chelcoach-gameplay");
      assert.equal(session.objectPath, `${ownerId}/${session.uploadId}/source`);
      assert.ok(session.objectPath.endsWith("/source"));
      assert.ok(!session.objectPath.includes("gameplay.mp4"));
      assert.equal(
        session.resumableEndpoint,
        "https://example.supabase.co/storage/v1/upload/resumable",
      );
      assert.equal(session.uploadUrl, "");

      const put = await fetch(`${base}/api/uploads/${session.uploadId}/content`, {
        method: "PUT",
        headers: { authorization: `Bearer ${token}`, "content-type": "video/mp4" },
        body: Buffer.alloc(128, 1),
      });
      assert.equal(put.status, 409);
      const body = (await put.json()) as { error: string };
      assert.equal(body.error, "STORAGE_UPLOAD_FAILED");

      // Completion derives path from DB only — ignore any client path.
      // Supabase mode enqueues inspection — must NOT mark ready or run ffprobe here.
      const complete = await fetch(`${base}/api/uploads/${session.uploadId}/complete`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ objectPath: "other-user/evil/source" }),
      });
      assert.equal(complete.status, 200);
      const detail = (await complete.json()) as {
        uploadStatus: string;
        inspection?: { status: string };
        pollAfterMs?: number;
      };
      assert.equal(detail.uploadStatus, "processing");
      assert.ok(detail.inspection);
      assert.equal(detail.inspection?.status, "queued");
      assert.ok(detail.pollAfterMs);

      // Idempotent re-complete reuses the same logical job.
      const again = await fetch(`${base}/api/uploads/${session.uploadId}/complete`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
      });
      assert.equal(again.status, 200);
      const againBody = (await again.json()) as { uploadStatus: string };
      assert.equal(againBody.uploadStatus, "processing");
    });
  });

  it("enforces concurrent upload quota before issuing a session", async () => {
    process.env.CHELCOACH_MAX_CONCURRENT_UPLOADS_PER_USER = "1";
    resetChelCoachConfigCacheForTests();
    await withServer(async (base, token) => {
      const first = await fetch(`${base}/api/uploads`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({
          filename: "a.mp4",
          contentType: "video/mp4",
          sizeBytes: 100,
          context: xboxContext(),
        }),
      });
      assert.equal(first.status, 201);
      const second = await fetch(`${base}/api/uploads`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({
          filename: "b.mp4",
          contentType: "video/mp4",
          sizeBytes: 100,
          context: xboxContext(),
        }),
      });
      assert.equal(second.status, 429);
    });
  });
});

// Silence unused Readable import warning path for future stream tests
void Readable;
