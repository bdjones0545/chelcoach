import { Router } from "express";
import { requireOwnerAuth } from "../auth/session";
import { configDiagnostics, getChelCoachConfig } from "../config/chelcoachConfig";
import { computeReadiness, readinessPublicView } from "../config/readiness";
import { persistenceBackend } from "../persistence";

export const readinessRouter = Router();

/**
 * GET /api/admin/readiness — authenticated, safe diagnostics (no secrets).
 * Not a public health probe; requires owner session.
 */
readinessRouter.get("/admin/readiness", requireOwnerAuth, (_req, res) => {
  const config = getChelCoachConfig();
  const readiness = computeReadiness(config);
  res.setHeader("Cache-Control", "no-store, private");
  res.json({
    ...readinessPublicView(readiness),
    persistence: persistenceBackend(),
    config: configDiagnostics(config),
  });
});

/** GET /api/health/readiness — coarse public gate (no secrets, no detailed misconfig). */
readinessRouter.get("/health/readiness", (_req, res) => {
  const readiness = computeReadiness();
  res.setHeader("Cache-Control", "no-store");
  res.status(readiness.analysisSubmissionEnabled ? 200 : 503).json({
    analysisSubmission: readiness.analysisSubmissionEnabled ? "enabled" : "disabled",
  });
});
