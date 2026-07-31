/**
 * Provider-independent analysis submission routes (Step 4).
 * Frontend never selects provider URL / signing / model.
 */
import { Router } from "express";
import { requireOwnerAuth, type AuthedRequest } from "../auth/session";
import {
  AnalysisSubmissionError,
  submitAnalysis,
} from "../provider/submissionService";
import { getScottyProvider } from "../provider/factory";
import { scottyCallbackEventSchema } from "../scottyContract";

export const analysisRouter = Router();

function uploadIdParam(req: import("express").Request): string {
  const raw = req.params.uploadId;
  return Array.isArray(raw) ? String(raw[0]) : String(raw);
}

function sendError(res: import("express").Response, err: unknown): void {
  if (err instanceof AnalysisSubmissionError) {
    res.status(err.httpStatus).json({
      error: err.code,
      message: err.message,
      retryable: err.code === "RATE_LIMITED" || err.code === "PROVIDER_UNAVAILABLE" || err.code === "ANALYSIS_TIMEOUT",
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

/**
 * Callback skeleton — feature-flagged OFF. Rejects all requests unless explicitly enabled.
 * Does not process production events in Step 4.
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
  // Step 4: acknowledge schema only — no processing.
  res.status(202).json({ accepted: false, reason: "callback_processing_disabled" });
});
