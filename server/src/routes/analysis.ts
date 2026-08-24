/**
 * Provider-independent analysis submission + status routes (Steps 4–5).
 * Frontend never selects provider URL / signing / model.
 */
import { Router } from "express";
import { z } from "zod";
import { requireOwnerAuth, type AuthedRequest } from "../auth/session";
import { getChelCoachConfig } from "../config/chelcoachConfig";
import {
  assertAnalysisSubmissionReady,
  computeReadiness,
} from "../config/readiness";
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
import { limits } from "../security/rateLimit";
import { requireInternalSecret } from "../security/secrets";
import {
  SCOTTY_CALLBACK_SIGNATURE_HEADER,
  SCOTTY_CALLBACK_TIMESTAMP_HEADER,
  verifyScottyCallback,
} from "../security/callbackSignature";

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

analysisRouter.post(
  "/uploads/:uploadId/analysis",
  requireOwnerAuth,
  limits.analysisSubmit,
  async (req, res) => {
    try {
      assertAnalysisSubmissionReady();
      const { ownerId } = req as AuthedRequest;
      // Never trust client-supplied owner IDs.
      const body = { ...(req.body as Record<string, unknown>) };
      delete body.ownerId;
      delete body.userId;
      const result = await submitAnalysis({
        ownerId,
        uploadId: uploadIdParam(req),
        body,
      });
      res.status(202).json(result);
    } catch (err) {
      if ((err as { code?: string }).code === "ANALYSIS_NOT_READY") {
        const readiness = computeReadiness();
        res.status(503).json({
          error: "ANALYSIS_NOT_READY",
          message: "Analysis submission is not available.",
          retryable: false,
          reasons: readiness.reasons.slice(0, 8),
        });
        return;
      }
      sendError(res, err);
    }
  },
);

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
  limits.statusRead,
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
  limits.reportRead,
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
  limits.confirmation,
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
  limits.cancellation,
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
async function runAnalysisReconcile(
  req: import("express").Request,
  res: import("express").Response,
) {
  const config = getChelCoachConfig();
  const expected = config.secrets.reconcileSecret;
  // Platform cron issues GET + Authorization Bearer; operators use the custom header. Both compare
  // timing-safely against the same secret via requireInternalSecret.
  const headerSecret = req.header("x-chelcoach-reconcile-secret");
  const bearer = (req.header("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (
    !requireInternalSecret(headerSecret, expected) &&
    !requireInternalSecret(bearer, expected)
  ) {
    res.status(404).json({ error: "not_found", message: "No such endpoint." });
    return;
  }
  const limitRaw = Number((req.body as { limit?: number } | undefined)?.limit);
  // The route is transport only: all lifecycle logic — including the bounded acceptance-unknown
  // recovery — lives in the canonical service.
  const result = await getAnalysisReconciliationService().runBatch({
    limit: Number.isFinite(limitRaw) ? limitRaw : 25,
  });
  res.json({
    examined: result.examined,
    advanced: result.advanced,
    degraded: result.degraded,
    unchanged: result.unchanged,
    failed: result.failed,
  });
}

analysisRouter.post("/internal/analysis/reconcile", limits.internal, runAnalysisReconcile);
/** Vercel Cron uses GET + Authorization Bearer <secret>. */
analysisRouter.get("/internal/analysis/reconcile", limits.internal, runAnalysisReconcile);

/**
 * Authenticated callback receiver — feature-flagged OFF by default.
 * Authenticates exact transport bytes before parsing, claiming, or reading protected job state.
 * Body size is capped by the global JSON limit (256kb).
 */
analysisRouter.post("/internal/scotty/callbacks", limits.internal, async (req, res) => {
  const config = getChelCoachConfig();
  if (!config.transport.callbacksEnabled) {
    res.status(404).json({ error: "not_found", message: "No such endpoint." });
    return;
  }
  if (!config.transport.callbackSigningConfigured) {
    res.status(404).json({ error: "not_found", message: "No such endpoint." });
    return;
  }
  const callbackSecret = config.secrets.callbackSecret;
  const rawBody = (req as typeof req & { rawBody?: Buffer }).rawBody;
  if (
    !verifyScottyCallback({
      secret: callbackSecret,
      timestamp: req.header(SCOTTY_CALLBACK_TIMESTAMP_HEADER),
      signature: req.header(SCOTTY_CALLBACK_SIGNATURE_HEADER),
      rawBody,
    })
  ) {
    res.status(401).json({ error: "UNAUTHORIZED", message: "Missing or invalid signature." });
    return;
  }
  const parsed = scottyCallbackEventSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "INVALID_REQUEST", message: "Invalid callback event." });
    return;
  }
  const event = parsed.data;
  const jobs = getAnalysisJobRepository();
  const claim = await jobs.claimCallbackEvent({
    eventId: event.eventId,
    provider: "scotty",
    externalJobId: event.externalJobId,
    applicationRequestId: event.applicationRequestId,
    sequenceNumber: event.sequenceNumber,
    status: event.status,
  });
  if (!claim.claimed) {
    res.status(202).json({
      accepted: true,
      reason:
        claim.processingStatus === "received"
          ? "duplicate_event_in_progress"
          : "duplicate_event_idempotent",
    });
    return;
  }
  try {
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
        await jobs.completeCallbackEvent("scotty", event.eventId, "ignored_stale");
        res.status(202).json({ accepted: true, reason: "stale_sequence_ignored" });
        return;
      }
      if (decision.decision === "conflict") {
        await jobs.completeCallbackEvent("scotty", event.eventId, "rejected_conflict");
        res.status(409).json({ accepted: false, reason: "sequence_conflict" });
        return;
      }
    }
    // Callback-driven state transitions remain disabled; authenticated events are terminally
    // acknowledged so provider retries stop without duplicating any domain side effect.
    await jobs.completeCallbackEvent("scotty", event.eventId, "processed");
    res.status(202).json({ accepted: false, reason: "callback_processing_disabled" });
  } catch {
    await jobs.releaseCallbackEvent("scotty", event.eventId).catch(() => undefined);
    res.status(503).json({ accepted: false, reason: "callback_processing_retryable" });
  }
});
