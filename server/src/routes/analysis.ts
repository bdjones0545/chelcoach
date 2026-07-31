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
      const report = await getAnalysisReport({
        ownerId,
        applicationRequestId: requestIdParam(req),
      });
      res.json(report);
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
 * Callback skeleton — feature-flagged OFF. Rejects all requests unless explicitly enabled.
 * Does not process production events in Step 5.
 */
analysisRouter.post("/internal/scotty/callbacks", async (req, res) => {
  if (process.env.CHELCOACH_SCOTTY_CALLBACKS_ENABLED !== "1") {
    res.status(404).json({ error: "not_found", message: "No such endpoint." });
    return;
  }
  // Unsigned requests rejected even when flag is on.
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
  res.status(202).json({ accepted: false, reason: "callback_processing_disabled" });
});
