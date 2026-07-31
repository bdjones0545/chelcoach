/**
 * Provider-independent analysis submission + status routes (Steps 4–5).
 * Frontend never selects provider URL / signing / model.
 */
import { Router } from "express";
import { z } from "zod";
import { requireOwnerAuth, type AuthedRequest } from "../auth/session";
import {
  AnalysisSubmissionError,
  submitAnalysis,
} from "../provider/submissionService";
import {
  AnalysisStatusError,
  cancelAnalysis,
  confirmAnalysisPlayer,
  getAnalysisReport,
  getAnalysisStatus,
} from "../provider/statusService";
import { getScottyProvider } from "../provider/factory";
import { getAnalysisJobRepository } from "../provider/jobs/jobRepository";
import { getAnalysisReconciliationService } from "../provider/jobs/reconciliationService";
import { evaluateProviderStatusUpdate } from "../provider/jobs/sequence";
import { scottyCallbackEventSchema } from "../scottyContract";

export const analysisRouter = Router();

function uploadIdParam(req: import("express").Request): string {
  const raw = req.params.uploadId;
  return Array.isArray(raw) ? String(raw[0]) : String(raw);
}

function requestIdParam(req: import("express").Request): string {
  const raw = req.params.applicationRequestId;
  return Array.isArray(raw) ? String(raw[0]) : String(raw);
}

function sendError(res: import("express").Response, err: unknown): void {
  if (err instanceof AnalysisSubmissionError || err instanceof AnalysisStatusError) {
    res.status(err.httpStatus).json({
      error: err.code,
      message: err.message,
      retryable:
        err.code === "RATE_LIMITED" ||
        err.code === "PROVIDER_UNAVAILABLE" ||
        err.code === "ANALYSIS_TIMEOUT" ||
        err.code === "REPORT_NOT_READY",
    });
    return;
  }
  const message = err instanceof Error ? err.message : "Unexpected error.";
  console.error("[chelcoach-analysis] error:", message);
  res.status(500).json({ error: "ANALYSIS_FAILED", message: "Unexpected error." });
}

analysisRouter.post("/uploads/:uploadId/analysis", requireOwnerAuth, async (req, res) => {
  try {
    const { ownerId } = req as AuthedRequest;
    const result = await submitAnalysis({
      ownerId,
      uploadId: uploadIdParam(req),
      body: req.body,
    });
    res.status(202).json(result);
  } catch (err) {
    sendError(res, err);
  }
});

/**
 * Admin-ish provider health — authenticated, no secrets/URLs.
 */
analysisRouter.get("/analysis/provider-health", requireOwnerAuth, async (_req, res) => {
  try {
    const provider = getScottyProvider();
    const health = provider.health
      ? await provider.health()
      : {
          provider: provider.mode,
          configured: true,
          contractCompatible: true,
          status: "unknown" as const,
          checkedAt: new Date().toISOString(),
        };
    console.log(
      `[chelcoach-analysis] event=provider_health_checked provider=${health.provider} status=${health.status}`,
    );
    res.json(health);
  } catch (err) {
    sendError(res, err);
  }
});

analysisRouter.get(
  "/analysis/:applicationRequestId",
  requireOwnerAuth,
  async (req, res) => {
    try {
      const { ownerId } = req as AuthedRequest;
      const status = await getAnalysisStatus({
        ownerId,
        applicationRequestId: requestIdParam(req),
      });
      // Authenticated status must not be cached by browsers or intermediaries.
      res.setHeader("Cache-Control", "no-store");
      res.json(status);
    } catch (err) {
      sendError(res, err);
    }
  },
);

analysisRouter.get(
  "/analysis/:applicationRequestId/report",
  requireOwnerAuth,
  async (req, res) => {
    try {
      const { ownerId } = req as AuthedRequest;
      const payload = await getAnalysisReport({
        ownerId,
        applicationRequestId: requestIdParam(req),
      });
      // Ownership is rechecked on every request; private caching with revalidation is OK,
      // but no-store remains the safe first implementation.
      res.setHeader("Cache-Control", "private, no-store");
      // Never leak storage keys / fingerprints in the envelope.
      const json = JSON.stringify(payload);
      if (
        json.includes("storageObjectKey") ||
        json.includes("idempotencyKey") ||
        json.includes("requestFingerprint") ||
        json.includes("SCOTTY_BASE_URL")
      ) {
        res.status(500).json({ error: "INVALID_REQUEST", message: "Unsafe fields leaked into report response." });
        return;
      }
      res.json(payload);
    } catch (err) {
      sendError(res, err);
    }
  },
);

const remoteConfirmBodySchema = z.object({
  selectedCandidateId: z.string().trim().min(1).max(128),
});

analysisRouter.post(
  "/analysis/:applicationRequestId/player-confirmation",
  requireOwnerAuth,
  async (req, res) => {
    try {
      const { ownerId } = req as AuthedRequest;
      const parsed = remoteConfirmBodySchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        res.status(400).json({
          error: "PLAYER_CONFIRMATION_INVALID",
          message: "Invalid player confirmation payload.",
        });
        return;
      }
      const status = await confirmAnalysisPlayer({
        ownerId,
        applicationRequestId: requestIdParam(req),
        selectedCandidateId: parsed.data.selectedCandidateId,
      });
      res.json(status);
    } catch (err) {
      sendError(res, err);
    }
  },
);

const cancelBodySchema = z.object({
  reason: z.string().trim().max(200).optional(),
});

analysisRouter.post(
  "/analysis/:applicationRequestId/cancel",
  requireOwnerAuth,
  async (req, res) => {
    try {
      const { ownerId } = req as AuthedRequest;
      const parsed = cancelBodySchema.safeParse(req.body ?? {});
      const status = await cancelAnalysis({
        ownerId,
        applicationRequestId: requestIdParam(req),
        reason: parsed.success ? parsed.data.reason : undefined,
      });
      res.json(status);
    } catch (err) {
      sendError(res, err);
    }
  },
);

/**
 * Reconciliation entrypoint for an external scheduler (cron).
 * Protected by shared secret header — not for browsers.
 *
 * Suggested production cadence: once per minute.
 * Do not create one timer per job.
 */
analysisRouter.post("/internal/analysis/reconcile", async (req, res) => {
  const expected = process.env.CHELCOACH_RECONCILE_SECRET?.trim();
  if (!expected || req.header("x-chelcoach-reconcile-secret") !== expected) {
    res.status(404).json({ error: "not_found", message: "No such endpoint." });
    return;
  }
  const limitRaw = Number((req.body as { limit?: number } | undefined)?.limit);
  const result = await getAnalysisReconciliationService().runBatch({
    limit: Number.isFinite(limitRaw) ? limitRaw : 25,
  });
  res.json(result);
});

/**
 * Callback skeleton — feature-flagged OFF.
 * Dedupes event IDs when enabled; does not activate full callback processing yet.
 */
analysisRouter.post("/internal/scotty/callbacks", async (req, res) => {
  if (process.env.CHELCOACH_SCOTTY_CALLBACKS_ENABLED !== "1") {
    res.status(404).json({ error: "not_found", message: "No such endpoint." });
    return;
  }
  const sig = req.header("x-scotty-signature");
  if (!sig) {
    res.status(401).json({ error: "UNAUTHORIZED", message: "Missing signature." });
    return;
  }
  const parsed = scottyCallbackEventSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "INVALID_REQUEST", message: "Invalid callback event." });
    return;
  }
  const event = parsed.data;
  const jobs = getAnalysisJobRepository();
  const dedupe = await jobs.recordCallbackEvent({
    eventId: event.eventId,
    provider: "scotty",
    externalJobId: event.externalJobId,
    applicationRequestId: event.applicationRequestId,
    sequenceNumber: event.sequenceNumber,
    status: event.status,
  });
  if (!dedupe.inserted) {
    res.status(202).json({ accepted: true, reason: "duplicate_event_idempotent" });
    return;
  }
  const job = await jobs.getByApplicationRequestId(event.applicationRequestId);
  if (job) {
    const decision = evaluateProviderStatusUpdate({
      currentJob: job,
      incoming: {
        contractVersion: event.contractVersion,
        jobId: event.externalJobId,
        uploadId: job.uploadId,
        provider: job.provider,
        externalScottyJobId: event.externalJobId,
        applicationRequestId: event.applicationRequestId,
        status: event.status,
        sequenceNumber: event.sequenceNumber,
        reportReady: event.status === "completed",
        updatedAt: event.occurredAt,
      },
    });
    if (decision.decision === "stale") {
      res.status(202).json({ accepted: true, reason: "stale_sequence_ignored" });
      return;
    }
    if (decision.decision === "conflict") {
      res.status(409).json({ accepted: false, reason: "sequence_conflict" });
      return;
    }
  }
  // Step 6: acknowledge + dedupe only — full callback activation remains later.
  res.status(202).json({ accepted: false, reason: "callback_processing_disabled" });
});
