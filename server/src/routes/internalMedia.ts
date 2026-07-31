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
import type { ObjectStorage } from "../storage";
import { limits } from "../security/rateLimit";
import { requireInternalSecret } from "../security/secrets";
import { logSafe } from "../security/logging";

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

internalMediaRouter.post(
  "/internal/media/cleanup",
  limits.internal,
  async (req, res) => {
    const config = getChelCoachConfig();
    const expected = config.secrets.cleanupSecret;
    const provided = req.header("x-chelcoach-cleanup-secret");
    if (!requireInternalSecret(provided, expected)) {
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
  },
);

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
