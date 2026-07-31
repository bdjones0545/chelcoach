/**
 * Safe media-inspection worker verification.
 * npm run verify:media-worker
 *
 * Live opt-in: CHELCOACH_LIVE_MEDIA_WORKER_VERIFY=1
 * Never prints secrets, signed URLs, or object paths.
 */
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { loadLocalEnvFiles } from "../config/loadEnv";
import { wirePersistence } from "../persistence";
import { getMediaObjectStorage, setMediaObjectStorageForTests } from "../mediaStorage";
import { createSupabaseMediaObjectStorage } from "../storage/supabaseMediaObjectStorage";
import { gameplayObjectKey } from "../storage/supabaseStorageConfig";
import {
  getUploadRepository,
  resetUploadRepositoryForTests,
  setUploadRepositoryForTests,
} from "../uploads/repository";
import { DrizzleUploadRepository } from "../uploads/drizzleRepository";
import {
  getInspectionJobRepository,
  resetInspectionJobRepositoryForTests,
  setInspectionJobRepositoryForTests,
} from "./repository";
import { DrizzleInspectionJobRepository } from "./drizzleRepository";
import { createMediaInspectionWorker } from "./worker";
import { RETENTION_POLICY_VERSION } from "../scottyContract";
import { isDbConfigured } from "../db/client";

const here = dirname(fileURLToPath(import.meta.url));

function fail(msg: string): never {
  console.error(`[verify:media-worker] FAIL: ${msg}`);
  process.exit(1);
}

function ok(msg: string): void {
  console.log(`[verify:media-worker] ${msg}`);
}

function checkFfprobe(): void {
  const bin = process.env.FFPROBE_PATH?.trim() || "ffprobe";
  const r = spawnSync(bin, ["-version"], { encoding: "utf8" });
  if (r.status !== 0) fail(`ffprobe unavailable (${bin})`);
  ok(`ffprobe_available=true`);
}

async function runInjected(): Promise<void> {
  process.env.CHELCOACH_FORCE_MEMORY_REPOS = "1";
  process.env.CHELCOACH_MEDIA_INSPECTION_MODE = "worker";
  resetUploadRepositoryForTests();
  resetInspectionJobRepositoryForTests();

  // Tiny synthetic mp4-ish bytes won't pass real ffprobe — use Fake path via worker
  // only for claim/idempotency. Live path validates real ffprobe.
  const jobs = getInspectionJobRepository();
  const uploads = getUploadRepository();
  const now = new Date();
  const uploadId = randomUUID();
  const ownerId = "own_verify_media_worker";
  await uploads.create({
    uploadId,
    ownerId,
    storageProvider: "disk",
    storageObjectKey: `chelcoach/uploads/${ownerId}/${uploadId}/source`,
    originalFilename: "t.mp4",
    displayFilename: "t.mp4",
    mimeType: "video/mp4",
    declaredByteSize: 100,
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
    deletionAttemptCount: 0,
  });

  const jobA = await jobs.create({
    uploadId,
    ownerId,
    storageProvider: "disk",
    bucketAlias: "local-disk",
    objectKey: `chelcoach/uploads/${ownerId}/${uploadId}/source`,
    objectFingerprint: "fp-1",
    trustedByteSize: 100,
    trustedMimeType: "video/mp4",
  });
  const jobB = await jobs.create({
    uploadId,
    ownerId,
    storageProvider: "disk",
    bucketAlias: "local-disk",
    objectKey: `chelcoach/uploads/${ownerId}/${uploadId}/source`,
    objectFingerprint: "fp-1",
    trustedByteSize: 100,
    trustedMimeType: "video/mp4",
  });
  if (jobA.id !== jobB.id) fail("idempotent create should reuse job");
  ok("idempotent_create=true");

  const worker = createMediaInspectionWorker({ leaseMs: 60_000 });
  const claimed1 = await worker.claimNext({ workerId: "w1", now: new Date() });
  const claimed2 = await worker.claimNext({ workerId: "w2", now: new Date() });
  if (!claimed1) fail("expected claim");
  if (claimed2 && claimed2.id === claimed1.id) fail("double claim");
  ok("atomic_claim_no_double=true");

  // Stale recovery
  await jobs.update(claimed1.id, {
    status: "inspecting",
    workerId: "w1",
    claimExpiresAt: new Date(Date.now() - 1000).toISOString(),
  });
  const recovered = await worker.claimNext({ workerId: "w3", now: new Date() });
  if (!recovered || recovered.id !== claimed1.id) fail("stale claim not recovered");
  ok("stale_claim_recovery=true");
}

async function runLive(): Promise<void> {
  const url = (process.env.SUPABASE_URL ?? "").trim();
  const anon = (process.env.SUPABASE_ANON_KEY ?? "").trim();
  const service = (process.env.SUPABASE_SERVICE_ROLE_KEY ?? "").trim();
  if (!url || !anon || !service) fail("live requires SUPABASE_URL/ANON/SERVICE_ROLE");
  if (!isDbConfigured()) fail("live requires DATABASE_URL");

  delete process.env.CHELCOACH_FORCE_MEMORY_REPOS;
  process.env.CHELCOACH_MEDIA_STORAGE_MODE = "supabase_storage";
  process.env.CHELCOACH_MEDIA_INSPECTION_MODE = "worker";
  wirePersistence();
  setUploadRepositoryForTests(new DrizzleUploadRepository());
  setInspectionJobRepositoryForTests(new DrizzleInspectionJobRepository());
  setMediaObjectStorageForTests(createSupabaseMediaObjectStorage());

  const stamp = Date.now().toString(36);
  const email = `chelcoach.media.worker.${stamp}@example.com`;
  const password = `T3st!${stamp}Aa`;
  const admin = createClient(url, service, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const browser = createClient(url, anon, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  let userId = "";
  let objectKey = "";
  let uploadId = "";
  try {
    const created = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
    if (created.error || !created.data.user) fail(`create user: ${created.error?.message}`);
    userId = created.data.user.id;

    const sign = await browser.auth.signInWithPassword({ email, password });
    if (sign.error || !sign.data.session?.access_token) fail("sign-in failed");

    uploadId = randomUUID();
    objectKey = gameplayObjectKey(userId, uploadId);

    // Minimal valid-ish media: generate with ffmpeg if available, else skip live ffprobe success
    const { spawnSync } = await import("node:child_process");
    const tmp = `/tmp/chelcoach-worker-verify-${stamp}.mp4`;
    const gen = spawnSync(
      process.env.FFMPEG_PATH?.trim() || "ffmpeg",
      [
        "-y",
        "-f",
        "lavfi",
        "-i",
        "color=c=black:s=320x240:d=1",
        "-c:v",
        "libx264",
        "-t",
        "1",
        tmp,
      ],
      { encoding: "utf8" },
    );
    if (gen.status !== 0) fail("ffmpeg required to generate live test clip");

    const { readFileSync } = await import("node:fs");
    const bytes = readFileSync(tmp);
    const userClient = createClient(url, anon, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { Authorization: `Bearer ${sign.data.session.access_token}` } },
    });
    const bucket = process.env.SUPABASE_GAMEPLAY_BUCKET?.trim() || "chelcoach-gameplay";
    const up = await userClient.storage.from(bucket).upload(objectKey, bytes, {
      contentType: "video/mp4",
      upsert: false,
    });
    if (up.error) fail(`upload failed: ${up.error.message}`);
    ok("live_object_uploaded=true");

    const media = getMediaObjectStorage();
    const meta = await media.statObject(objectKey);
    if (!meta.exists) fail("stat missing after upload");

    const now = new Date();
    const uploads = getUploadRepository();
    await uploads.create({
      uploadId,
      ownerId: userId,
      storageProvider: "supabase",
      storageObjectKey: objectKey,
      originalFilename: "verify.mp4",
      displayFilename: "verify.mp4",
      mimeType: "video/mp4",
      declaredByteSize: bytes.length,
      storedByteSize: meta.byteSize || bytes.length,
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

    const fingerprint =
      meta.fingerprint || `${meta.byteSize}|${meta.contentType}|${meta.updatedAt ?? "v0"}`;
    const job = await getInspectionJobRepository().create({
      uploadId,
      ownerId: userId,
      storageProvider: "supabase",
      bucketAlias: bucket,
      objectKey,
      objectFingerprint: fingerprint,
      trustedByteSize: meta.byteSize || bytes.length,
      trustedMimeType: "video/mp4",
    });
    ok(`inspection_job_created status=${job.status}`);

    const worker = createMediaInspectionWorker();
    const claimed = await worker.claimNext({ workerId: "live-verify", now: new Date() });
    if (!claimed || claimed.id !== job.id) fail("failed to claim live job");
    const result = await worker.process({ workerId: "live-verify", jobId: claimed.id });
    if (!result.ok || result.status !== "completed") {
      fail(`live process failed status=${result.status} code=${result.errorCode}`);
    }
    ok("live_inspection_completed=true");

    const upload = await uploads.get(uploadId);
    if (!upload || upload.uploadStatus !== "ready") fail("upload not ready after inspection");
    if (!upload.trustedMedia?.durationSec) fail("trusted duration missing");
    ok(`upload_ready duration=${upload.trustedMedia.durationSec}`);

    await media.deleteObject(objectKey);
    ok("live_object_cleaned=true");
    await getInspectionJobRepository().cancelActiveForUpload(uploadId, "verify cleanup").catch(() => undefined);
    // Soft-delete upload row by marking expired
    await uploads.update(uploadId, {
      uploadStatus: "expired",
      deletedAt: new Date().toISOString(),
    });
    ok("live_records_cleaned=true");
  } finally {
    if (userId) await admin.auth.admin.deleteUser(userId).catch(() => undefined);
    if (objectKey) {
      try {
        await createSupabaseMediaObjectStorage().deleteObject(objectKey);
      } catch {
        /* ignore */
      }
    }
  }
}

async function main(): Promise<void> {
  loadLocalEnvFiles(resolve(here, "../.."));
  loadLocalEnvFiles(resolve(here, "../../.."));
  checkFfprobe();
  await runInjected();
  ok("injected_checks=pass");

  if (process.env.CHELCOACH_LIVE_MEDIA_WORKER_VERIFY === "1") {
    ok("live_verify=start");
    await runLive();
    ok("live_verify=pass");
  } else {
    ok("live_verify=skipped (set CHELCOACH_LIVE_MEDIA_WORKER_VERIFY=1)");
  }
  ok("result=PASS");
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  fail(message.replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]"));
});
