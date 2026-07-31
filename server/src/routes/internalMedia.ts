/**
 * Internal media cleanup scheduler foundation (Step 10).
 * Protected by a distinct cleanup secret — never browser cookies alone.
 */
import { Router } from "express";
import { getChelCoachConfig } from "../config/chelcoachConfig";
import { getMediaObjectStorage } from "../mediaStorage";
import { createMediaRetentionService } from "../retention/cleanup";
import { getRetentionRepository } from "../retention/repository";
import { reconcileExpiredPending } from "../storage/storageReconciliation";
import { getMediaInspectionWorker } from "../inspection/worker";
import type { ObjectStorage } from "../storage";
import { limits } from "../security/rateLimit";
import { requireInternalSecret } from "../security/secrets";
import { logSafe } from "../security/logging";
import { randomUUID } from "node:crypto";

/** Adapt media object store to the retention ObjectStorage delete contract. */
function mediaAsObjectStorage(): ObjectStorage {
  const media = getMediaObjectStorage();
  return {
    backend: "memory",
    async put() {
      throw new Error("cleanup storage is delete-only");
    },
    async exists(key: string) {
      return media.exists(key);
    },
    async delete(key: string) {
      return media.deleteObject(key);
    },
  };
}

export const internalMediaRouter = Router();

async function runCleanup(req: import("express").Request, res: import("express").Response) {
  const config = getChelCoachConfig();
  const expected = config.secrets.cleanupSecret;
  const headerSecret = req.header("x-chelcoach-cleanup-secret");
  const bearer = (req.header("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (
    !requireInternalSecret(headerSecret, expected) &&
    !requireInternalSecret(bearer, expected)
  ) {
    res.status(404).json({ error: "not_found", message: "No such endpoint." });
    return;
  }

  const limitRaw = Number((req.body as { limit?: number } | undefined)?.limit);
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 100) : 50;
  const svc = createMediaRetentionService({
    repo: getRetentionRepository(),
    storage: mediaAsObjectStorage(),
  });
  const result = await svc.runCleanupBatch({ limit, workerId: "http-cleanup" });
  logSafe("chelcoach-cleanup", "batch_completed", {
    examined: result.examined,
    deleted: result.deleted,
    deferred: result.deferred,
    failed: result.failed,
  });
  res.json({
    examined: result.examined,
    deleted: result.deleted,
    deferred: result.deferred,
    failed: result.failed,
    skipped: result.skipped,
    forcedExpiredJobs: result.forcedExpiredJobs,
  });
}

internalMediaRouter.post("/internal/media/cleanup", limits.internal, runCleanup);
/** Vercel Cron uses GET + Authorization Bearer <secret>. */
internalMediaRouter.get("/internal/media/cleanup", limits.internal, runCleanup);

/** Bounded DB-driven storage reconciliation (orphans / missing objects). */
internalMediaRouter.post(
  "/internal/media/storage-reconcile",
  limits.internal,
  async (req, res) => {
    const config = getChelCoachConfig();
    const expected = config.secrets.reconcileSecret;
    const provided = req.header("x-chelcoach-reconcile-secret");
    if (!requireInternalSecret(provided, expected)) {
      res.status(404).json({ error: "not_found", message: "No such endpoint." });
      return;
    }
    const limitRaw = Number((req.body as { limit?: number } | undefined)?.limit);
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 100) : 50;
    const repair = (req.body as { repair?: boolean } | undefined)?.repair !== false;
    const result = await reconcileExpiredPending(limit, repair);
    logSafe("chelcoach-storage-reconcile", "batch_completed", {
      examined: result.examined,
      issues: result.issues.length,
      repaired: result.repaired,
    });
    res.json({
      examined: result.examined,
      issueCount: result.issues.length,
      repaired: result.repaired,
      kinds: result.issues.map((i) => i.kind),
    });
  },
);

/**
 * Bounded inspection-worker kick (control plane only).
 * Preferred production path: dedicated worker process claiming from Postgres.
 * This endpoint is for Cron/ops wake-ups — it must not download large media itself
 * when CHELCOACH_INSPECTION_WORKER_INLINE=0 (default). When inline=1 (dev/test),
 * it may process a tiny batch in-process (never enable on Vercel).
 */
internalMediaRouter.post(
  "/internal/media/inspection-worker",
  limits.internal,
  async (req, res) => {
    const config = getChelCoachConfig();
    const expected = config.secrets.inspectionWorkerSecret;
    const provided = req.header("x-chelcoach-inspection-worker-secret");
    if (!requireInternalSecret(provided, expected)) {
      res.status(404).json({ error: "not_found", message: "No such endpoint." });
      return;
    }

    const inline = process.env.CHELCOACH_INSPECTION_WORKER_INLINE === "1";
    if (!inline) {
      // Wake signal only — dedicated worker polls DB. Do not run ffprobe here.
      logSafe("chelcoach-inspection", "wake_acknowledged", { inline: false });
      res.json({
        mode: "wake",
        message: "Inspection worker wake acknowledged. Dedicated worker claims jobs from Postgres.",
      });
      return;
    }

    if (config.isProduction || config.storage.mode === "supabase_storage") {
      // Fail closed: never inline-inspect supabase media inside the API process.
      res.status(409).json({
        error: "WORKER_UNAVAILABLE",
        message: "Inline inspection is disabled for this deployment. Run the dedicated worker.",
      });
      return;
    }

    const limitRaw = Number((req.body as { limit?: number } | undefined)?.limit);
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 5) : 1;
    const workerId = `inline-${randomUUID().slice(0, 8)}`;
    const batch = await getMediaInspectionWorker().runBatch({ workerId, limit });
    logSafe("chelcoach-inspection", "inline_batch_completed", {
      processed: batch.processed,
    });
    res.json({
      mode: "inline",
      processed: batch.processed,
      results: batch.results.map((r) => ({
        jobId: r.jobId,
        uploadId: r.uploadId,
        status: r.status,
        ok: r.ok,
        errorCode: r.errorCode,
      })),
    });
  },
);
