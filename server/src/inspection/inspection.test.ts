/**
 * Media inspection worker unit tests (no live Supabase required).
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { RETENTION_POLICY_VERSION } from "../scottyContract";
import { resetUploadRepositoryForTests, getUploadRepository } from "../uploads/repository";
import {
  resetInspectionJobRepositoryForTests,
  getInspectionJobRepository,
} from "./repository";
import { createMediaInspectionWorker } from "./worker";
import {
  getMediaObjectStorage,
  resetMediaObjectStorageForTests,
  setMediaObjectStorageForTests,
  type MediaObjectStorage,
  type StoredObjectMetadata,
} from "../mediaStorage";
import { Readable } from "node:stream";
import { createApp } from "../app";
import { createOwnerSession, resetSessionsForTests } from "../auth/session";
import type { AddressInfo } from "node:net";
import { resetChelCoachConfigCacheForTests } from "../config/chelcoachConfig";
import { setMediaInspectorForTests, FakeMediaInspector } from "../media/inspector";

async function seedProcessingUpload(ownerId: string, uploadId: string, objectKey: string) {
  const now = new Date();
  await getUploadRepository().create({
    uploadId,
    ownerId,
    storageProvider: "disk",
    storageObjectKey: objectKey,
    originalFilename: "clip.mp4",
    displayFilename: "clip.mp4",
    mimeType: "video/mp4",
    declaredByteSize: 1024,
    storedByteSize: 1024,
    uploadStatus: "processing",
    context: {
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
    retentionPolicyVersion: RETENTION_POLICY_VERSION,
    expiresAt: new Date(now.getTime() + 3600_000).toISOString(),
    absoluteDeleteAt: new Date(now.getTime() + 7200_000).toISOString(),
    pendingExpiresAt: new Date(now.getTime() + 3600_000).toISOString(),
    createdAt: now.toISOString(),
    uploadedAt: now.toISOString(),
    deletionAttemptCount: 0,
  });
}

beforeEach(() => {
  process.env.NODE_ENV = "test";
  process.env.CHELCOACH_FORCE_MEMORY_REPOS = "1";
  process.env.CHELCOACH_MEDIA_INSPECTION_MODE = "worker";
  delete process.env.CHELCOACH_MEDIA_STORAGE_MODE;
  resetChelCoachConfigCacheForTests();
  resetSessionsForTests();
  resetUploadRepositoryForTests();
  resetInspectionJobRepositoryForTests();
  resetMediaObjectStorageForTests();
});

afterEach(() => {
  delete process.env.CHELCOACH_MEDIA_INSPECTION_MODE;
  resetChelCoachConfigCacheForTests();
  setMediaInspectorForTests(undefined);
  resetMediaObjectStorageForTests();
});

describe("inspection job idempotency + claims", () => {
  it("reuses job for same upload fingerprint", async () => {
    const jobs = getInspectionJobRepository();
    await seedProcessingUpload("owner-a", "11111111-1111-4111-8111-111111111111", "k/source");
    const a = await jobs.create({
      uploadId: "11111111-1111-4111-8111-111111111111",
      ownerId: "owner-a",
      storageProvider: "disk",
      bucketAlias: "local-disk",
      objectKey: "k/source",
      objectFingerprint: "fp",
    });
    const b = await jobs.create({
      uploadId: "11111111-1111-4111-8111-111111111111",
      ownerId: "owner-a",
      storageProvider: "disk",
      bucketAlias: "local-disk",
      objectKey: "k/source",
      objectFingerprint: "fp",
    });
    assert.equal(a.id, b.id);
  });

  it("concurrent workers claim different jobs", async () => {
    const jobs = getInspectionJobRepository();
    const u1 = "11111111-1111-4111-8111-111111111111";
    const u2 = "22222222-2222-4222-8222-222222222222";
    await seedProcessingUpload("o", u1, "a/source");
    await seedProcessingUpload("o", u2, "b/source");
    await jobs.create({
      uploadId: u1,
      ownerId: "o",
      storageProvider: "disk",
      bucketAlias: "local",
      objectKey: "a/source",
      objectFingerprint: "fp1",
    });
    await jobs.create({
      uploadId: u2,
      ownerId: "o",
      storageProvider: "disk",
      bucketAlias: "local",
      objectKey: "b/source",
      objectFingerprint: "fp2",
    });
    const worker = createMediaInspectionWorker({ leaseMs: 60_000 });
    const c1 = await worker.claimNext({ workerId: "w1", now: new Date() });
    const c2 = await worker.claimNext({ workerId: "w2", now: new Date() });
    assert.ok(c1);
    assert.ok(c2);
    assert.notEqual(c1!.id, c2!.id);
  });

  it("stale claim recovers; active claim not stolen", async () => {
    const jobs = getInspectionJobRepository();
    const uploadId = "11111111-1111-4111-8111-111111111111";
    await seedProcessingUpload("o", uploadId, "k/source");
    const job = await jobs.create({
      uploadId,
      ownerId: "o",
      storageProvider: "disk",
      bucketAlias: "local",
      objectKey: "k/source",
      objectFingerprint: "fp",
    });
    const worker = createMediaInspectionWorker({ leaseMs: 60_000 });
    const claimed = await worker.claimNext({ workerId: "w1", now: new Date() });
    assert.equal(claimed?.id, job.id);
    const stolen = await worker.claimNext({ workerId: "w2", now: new Date() });
    assert.equal(stolen, null);

    await jobs.update(job.id, {
      status: "inspecting",
      claimExpiresAt: new Date(Date.now() - 1000).toISOString(),
    });
    const recovered = await worker.claimNext({ workerId: "w2", now: new Date() });
    assert.equal(recovered?.id, job.id);
    assert.equal(recovered?.workerId, "w2");
  });
});

describe("completion enqueues inspection in worker mode", () => {
  it("complete does not mark ready and does not require ffprobe", async () => {
    process.env.CHELCOACH_MEDIA_STORAGE_MODE = "supabase_storage";
    process.env.SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_ANON_KEY = "anon";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service";
    resetChelCoachConfigCacheForTests();

    const objectKey = "owner/upload/source";
    const fake: MediaObjectStorage = {
      backend: "supabase",
      createObjectKey(ownerId, uploadId) {
        return `${ownerId}/${uploadId}/source`;
      },
      async openWriteStream() {
        throw new Error("no");
      },
      async statObject(key): Promise<StoredObjectMetadata> {
        return {
          objectKey: key,
          byteSize: 2048,
          contentType: "video/mp4",
          exists: true,
          fingerprint: "fp-abc",
        };
      },
      async openReadStream() {
        return Readable.from(Buffer.alloc(10));
      },
      async deleteObject() {
        return { deleted: true, alreadyAbsent: false };
      },
      async exists() {
        return true;
      },
    };
    setMediaObjectStorageForTests(fake);
    // If complete incorrectly called inspector, this would throw.
    setMediaInspectorForTests(
      new FakeMediaInspector(async () => {
        throw new Error("ffprobe must not run in API complete");
      }),
    );

    const app = createApp();
    const server = app.listen(0);
    await new Promise<void>((r) => server.once("listening", () => r()));
    const { port } = server.address() as AddressInfo;
    const base = `http://127.0.0.1:${port}`;
    const session = createOwnerSession();
    try {
      const create = await fetch(`${base}/api/uploads`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${session.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          filename: "g.mp4",
          contentType: "video/mp4",
          sizeBytes: 2048,
          context: {
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
        }),
      });
      assert.equal(create.status, 201);
      const sessionBody = (await create.json()) as { uploadId: string; objectPath: string };
      // Align fake key with server-generated path
      void objectKey;
      void getMediaObjectStorage;

      const complete = await fetch(`${base}/api/uploads/${sessionBody.uploadId}/complete`, {
        method: "POST",
        headers: { authorization: `Bearer ${session.token}` },
      });
      assert.equal(complete.status, 200);
      const detail = (await complete.json()) as {
        uploadStatus: string;
        inspection?: { status: string; message: string };
      };
      assert.equal(detail.uploadStatus, "processing");
      assert.equal(detail.inspection?.status, "queued");
      assert.match(detail.inspection?.message ?? "", /waiting for verification/i);

      const job = await getInspectionJobRepository().getActiveByUpload(sessionBody.uploadId);
      assert.ok(job);
      assert.equal(job!.status, "queued");
      assert.equal(job!.objectFingerprint, "fp-abc");
    } finally {
      server.close();
      delete process.env.CHELCOACH_MEDIA_STORAGE_MODE;
      delete process.env.SUPABASE_URL;
      delete process.env.SUPABASE_ANON_KEY;
      delete process.env.SUPABASE_SERVICE_ROLE_KEY;
      resetChelCoachConfigCacheForTests();
    }
  });
});
