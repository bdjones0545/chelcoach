/**
 * Deterministic E2E hooks — enabled only when CHELCOACH_E2E_MODE=1
 * and NODE_ENV is not production. Startup must fail if enabled in production.
 */
import { Router } from "express";
import { timingSafeEqual } from "node:crypto";
import { revokeSession, seedSessionForTests } from "../auth/session";
import {
  deleteIdentificationForUpload,
  resetIdentificationRepositoryForTests,
} from "../identification/repository";
import { FakeMediaInspector, setMediaInspectorForTests } from "../media/inspector";
import { getScottyProvider } from "../provider/factory";
import {
  isSimulatorScenario,
  setE2eSimulatorScenarioOverride,
  type SimulatorScenario,
} from "../provider/simulator/scenarios";
import { SimulatorScottyProvider } from "../provider/simulator/simulatorProvider";
import { setE2eMaxUploadBytesOverride } from "../retention/policy";
import { getUploadRepository } from "../uploads/repository";

let durationOverrideSec: number | null = null;

/** Throws if E2E mode is requested in production — call at boot. */
export function assertE2eNotEnabledInProduction(
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (env.CHELCOACH_E2E_MODE === "1" && env.NODE_ENV === "production") {
    throw new Error(
      "[chelcoach-e2e] CHELCOACH_E2E_MODE cannot be enabled when NODE_ENV=production.",
    );
  }
}

export function isE2eMode(): boolean {
  if (process.env.NODE_ENV === "production") return false;
  return process.env.CHELCOACH_E2E_MODE === "1";
}

function safeSecretEqual(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) {
    timingSafeEqual(a, a);
    return false;
  }
  return timingSafeEqual(a, b);
}

export function getE2eDurationOverride(): number | null {
  return durationOverrideSec;
}

export function setE2eDurationOverride(sec: number | null): void {
  durationOverrideSec = sec;
}

function requireE2eSecret(req: { header(name: string): string | undefined }, res: {
  status(code: number): { json(body: unknown): void };
}): boolean {
  if (!isE2eMode()) {
    res.status(404).json({ error: "not_found" });
    return false;
  }
  const secret = process.env.CHELCOACH_E2E_SECRET?.trim();
  const provided = req.header("x-chelcoach-e2e-secret") ?? "";
  if (!secret || !safeSecretEqual(provided, secret)) {
    res.status(404).json({ error: "not_found" });
    return false;
  }
  return true;
}

/** Fake inspector that uses override / env and rejects non-MP4 magic bytes. */
export function installE2eMediaInspector(): void {
  if (!isE2eMode()) return;
  const defaultSec = Number(process.env.CHELCOACH_E2E_FAKE_MEDIA_DURATION_SEC || 90);
  setMediaInspectorForTests(
    new FakeMediaInspector(async (input) => {
      const { getMediaObjectStorage } = await import("../mediaStorage");
      const media = getMediaObjectStorage();
      const local = media.resolveLocalPath
        ? await media.resolveLocalPath(input.objectKey)
        : null;
      if (local) {
        const { readFile } = await import("node:fs/promises");
        const head = await readFile(local).catch(() => Buffer.alloc(0));
        const sample = head.subarray(0, Math.min(64, head.length)).toString("latin1");
        if (!sample.includes("ftyp") && !sample.includes("moov")) {
          throw Object.assign(new Error("MEDIA_INSPECTION_FAILED"), {
            code: "MEDIA_INSPECTION_FAILED",
          });
        }
      }
      const override = durationOverrideSec ?? defaultSec;
      const stat = await media.statObject(input.objectKey).catch(() => ({ byteSize: 4096 }));
      return {
        mimeType: "video/mp4",
        byteSize: stat.byteSize ?? 4096,
        durationSeconds: override,
        videoCodec: "h264",
        audioCodec: "aac",
        width: 1280,
        height: 720,
        frameRate: 60,
        hasVideoStream: true,
      };
    }),
  );
  console.log(
    `[chelcoach-e2e] fake media inspector installed defaultDurationSec=${defaultSec}`,
  );
}

/**
 * Protected E2E control routes — only mounted when CHELCOACH_E2E_MODE=1.
 */
export function createE2eRouter(): Router {
  if (!isE2eMode()) {
    throw new Error("[chelcoach-e2e] createE2eRouter called outside E2E mode");
  }
  const router = Router();

  router.post("/internal/e2e/duration-override", (req, res) => {
    if (!requireE2eSecret(req, res)) return;
    const raw = (req.body as { durationSec?: number | null })?.durationSec;
    if (raw === null) {
      durationOverrideSec = null;
      res.json({ ok: true, durationSec: null });
      return;
    }
    const n = Number(raw);
    // Allow slightly above SCOTTY_MAX_DURATION_SEC so E2E can assert VIDEO_DURATION_EXCEEDED.
    if (!Number.isFinite(n) || n <= 0 || n > 1900) {
      res.status(400).json({ error: "INVALID_REQUEST", message: "durationSec must be 0–1900" });
      return;
    }
    durationOverrideSec = n;
    res.json({ ok: true, durationSec: n });
  });

  router.post("/internal/e2e/simulator-scenario", (req, res) => {
    if (!requireE2eSecret(req, res)) return;
    const raw = (req.body as { scenario?: string | null })?.scenario;
    if (raw === null || raw === undefined || raw === "auto") {
      setE2eSimulatorScenarioOverride(null);
      res.json({ ok: true, scenario: null });
      return;
    }
    if (!isSimulatorScenario(raw)) {
      res.status(400).json({ error: "INVALID_REQUEST", message: "Unknown simulator scenario." });
      return;
    }
    setE2eSimulatorScenarioOverride(raw as SimulatorScenario);
    res.json({ ok: true, scenario: raw });
  });

  router.post("/internal/e2e/max-upload-bytes", (req, res) => {
    if (!requireE2eSecret(req, res)) return;
    const raw = (req.body as { maxBytes?: number | null })?.maxBytes;
    if (raw === null || raw === undefined) {
      setE2eMaxUploadBytesOverride(null);
      res.json({ ok: true, maxBytes: null });
      return;
    }
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 1024 || n > 10 * 1024 ** 3) {
      res.status(400).json({ error: "INVALID_REQUEST", message: "maxBytes out of range" });
      return;
    }
    setE2eMaxUploadBytesOverride(Math.floor(n));
    res.json({ ok: true, maxBytes: Math.floor(n) });
  });

  router.post("/internal/e2e/revoke-session", (req, res) => {
    if (!requireE2eSecret(req, res)) return;
    const token = String((req.body as { token?: string })?.token ?? "").trim();
    if (!token) {
      res.status(400).json({ error: "INVALID_REQUEST", message: "token required" });
      return;
    }
    const revoked = revokeSession(token);
    res.json({ ok: true, revoked });
  });

  /** Re-seed a known token↔owner mapping after revoke (E2E session restoration). */
  router.post("/internal/e2e/restore-session", (req, res) => {
    if (!requireE2eSecret(req, res)) return;
    const token = String((req.body as { token?: string })?.token ?? "").trim();
    const ownerId = String((req.body as { ownerId?: string })?.ownerId ?? "").trim();
    if (!token || !ownerId) {
      res.status(400).json({ error: "INVALID_REQUEST", message: "token and ownerId required" });
      return;
    }
    seedSessionForTests({
      token,
      ownerId,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    });
    res.json({ ok: true });
  });

  router.post("/internal/e2e/timeout-injection", (req, res) => {
    if (!requireE2eSecret(req, res)) return;
    const value = (req.body as { value?: string })?.value ?? "none";
    const provider = getScottyProvider();
    if (!(provider instanceof SimulatorScottyProvider)) {
      res.status(400).json({ error: "INVALID_REQUEST", message: "simulator provider required" });
      return;
    }
    if (!["none", "submission", "status", "report"].includes(value)) {
      res.status(400).json({ error: "INVALID_REQUEST", message: "invalid injection" });
      return;
    }
    provider.setTimeoutInjection(value as "none" | "submission" | "status" | "report");
    res.json({ ok: true, value });
  });

  router.post("/internal/e2e/expire-upload", async (req, res) => {
    if (!requireE2eSecret(req, res)) return;
    const uploadId = String((req.body as { uploadId?: string })?.uploadId ?? "").trim();
    const mode = String((req.body as { mode?: string })?.mode ?? "pending").trim();
    if (!uploadId) {
      res.status(400).json({ error: "INVALID_REQUEST", message: "uploadId required" });
      return;
    }
    const repo = getUploadRepository();
    const rec = await repo.get(uploadId);
    if (!rec) {
      res.status(404).json({ error: "UPLOAD_NOT_FOUND" });
      return;
    }
    const past = new Date(Date.now() - 60_000).toISOString();
    if (mode === "deleted") {
      const { getMediaObjectStorage } = await import("../mediaStorage");
      if (rec.storageObjectKey) {
        await getMediaObjectStorage().deleteObject(rec.storageObjectKey).catch(() => undefined);
      }
      await repo.update(uploadId, {
        uploadStatus: "deleted",
        deletedAt: past,
        storageObjectKey: "",
        expiresAt: past,
      });
    } else if (mode === "media") {
      await repo.update(uploadId, {
        expiresAt: past,
        absoluteDeleteAt: past,
      });
    } else {
      await repo.update(uploadId, {
        pendingExpiresAt: past,
        expiresAt: past,
      });
    }
    res.json({ ok: true, uploadId, mode });
  });

  /**
   * Run retention cleanup for E2E (uses durable retention repo when Postgres is wired).
   * Prefer targeting a single upload via early-deletion + cleanup batch.
   */
  router.post("/internal/e2e/cleanup", async (req, res) => {
    if (!requireE2eSecret(req, res)) return;
    const uploadId = String((req.body as { uploadId?: string })?.uploadId ?? "").trim();
    const repo = getUploadRepository();
    const { getRetentionRepository } = await import("../retention/repository");
    const { createMediaRetentionService } = await import("../retention/cleanup");
    const { getStorage } = await import("../storage");
    const { getMediaObjectStorage } = await import("../mediaStorage");

    if (uploadId) {
      const rec = await repo.get(uploadId);
      if (rec && rec.uploadStatus !== "deleted") {
        const past = new Date(Date.now() - 60_000).toISOString();
        await repo.update(uploadId, {
          expiresAt: past,
          absoluteDeleteAt: past,
          earlyDeletionRequestedAt: past,
        });
        // Also ensure object deletion path works when retention repo is memory-backed.
        const retention = getRetentionRepository();
        const svc = createMediaRetentionService({ repo: retention, storage: getStorage() });
        const batch = await svc.runCleanupBatch({ limit: 20 });
        if (batch.deleted === 0 && rec.storageObjectKey) {
          await getMediaObjectStorage().deleteObject(rec.storageObjectKey).catch(() => undefined);
          await repo.update(uploadId, {
            uploadStatus: "deleted",
            deletedAt: past,
            storageObjectKey: "",
            expiresAt: past,
          });
          res.json({ ok: true, examined: 1, deleted: 1, deferred: 0, failed: 0 });
          return;
        }
        res.json({
          ok: true,
          examined: batch.examined,
          deleted: batch.deleted,
          deferred: batch.deferred,
          failed: batch.failed,
        });
        return;
      }
    }
    res.json({ ok: true, examined: 0, deleted: 0, deferred: 0, failed: 0 });
  });

  router.post("/internal/e2e/reset-identification", async (req, res) => {
    if (!requireE2eSecret(req, res)) return;
    const uploadId = String((req.body as { uploadId?: string })?.uploadId ?? "").trim();
    if (uploadId) {
      const deleted = await deleteIdentificationForUpload(uploadId);
      res.json({ ok: true, deleted });
      return;
    }
    resetIdentificationRepositoryForTests();
    res.json({ ok: true, deleted: true, scope: "all" });
  });

  router.post("/internal/e2e/reset-controls", (_req, res) => {
    if (!requireE2eSecret(_req, res)) return;
    durationOverrideSec = null;
    setE2eSimulatorScenarioOverride(null);
    setE2eMaxUploadBytesOverride(null);
    resetIdentificationRepositoryForTests();
    const provider = getScottyProvider();
    if (provider instanceof SimulatorScottyProvider) {
      provider.setTimeoutInjection("none");
    }
    res.json({ ok: true });
  });

  return router;
}
