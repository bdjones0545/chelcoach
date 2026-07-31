import { Router } from "express";
import { requireOwnerAuth } from "../auth/session";
import { configDiagnostics, getChelCoachConfig } from "../config/chelcoachConfig";
import { computeReadiness, readinessPublicView } from "../config/readiness";
import { safeDatabaseDiagnostics } from "../db/client";
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
  const body = {
    ...readinessPublicView(readiness),
    persistence: persistenceBackend(),
    database: safeDatabaseDiagnostics(),
    config: configDiagnostics(config),
  };
  const serialized = JSON.stringify(body);
  if (/postgres(?:ql)?:\/\//i.test(serialized) || /SERVICE_ROLE|password=/i.test(serialized)) {
    res.status(500).json({ error: "internal_error", message: "Unsafe diagnostics blocked." });
    return;
  }
  res.json(body);
});

/** GET /api/health/readiness — coarse public gate (no secrets, no detailed misconfig). */
readinessRouter.get("/health/readiness", (_req, res) => {
  const readiness = computeReadiness();
  res.setHeader("Cache-Control", "no-store");
  res.status(readiness.analysisSubmissionEnabled ? 200 : 503).json({
    analysisSubmission: readiness.analysisSubmissionEnabled ? "enabled" : "disabled",
  });
});
