import { Router } from "express";
import { requireOwnerAuth } from "../auth/session";
import { configDiagnostics, getChelCoachConfig } from "../config/chelcoachConfig";
import { computeReadiness, readinessPublicView } from "../config/readiness";
import { safeDatabaseDiagnostics } from "../db/client";
import { persistenceBackend } from "../persistence";
import { getScottyProvider } from "../provider/factory";

/** How long the public gate waits for the analysis gateway before calling it unreachable. */
const GATEWAY_PROBE_TIMEOUT_MS = 3_000;

/**
 * Configuration says the provider is set up; this asks the provider whether it is actually
 * there. A dead or fake gateway closes submission at the gate instead of failing every job
 * after upload. Fail-closed on timeout or throw — the same answer the user would get later.
 */
async function gatewayReachable(): Promise<{ ok: boolean; reason?: string }> {
  const provider = getScottyProvider();
  if (!provider.health) return { ok: true };
  try {
    const health = await Promise.race([
      provider.health(),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), GATEWAY_PROBE_TIMEOUT_MS).unref?.()),
    ]);
    if (!health) return { ok: false, reason: "GATEWAY_PROBE_TIMEOUT" };
    // "degraded" means busy (simulator/worker under load) or a fake gateway provider; the deploy
    // scripts refuse the latter and the former is backpressure, not an outage — stay open, log it.
    if (health.status === "healthy" || health.status === "degraded") {
      if (health.status === "degraded") console.warn(`[chelcoach-readiness] gateway degraded: ${health.message ?? ""}`);
      return { ok: true };
    }
    return { ok: false, reason: `GATEWAY_${health.status.toUpperCase()}` };
  } catch {
    return { ok: false, reason: "GATEWAY_PROBE_FAILED" };
  }
}

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

/**
 * GET /api/health/readiness — coarse public gate (no secrets, no detailed misconfig).
 * The response stays coarse on purpose; the reason codes go to the server log so an operator
 * reading runtime logs can see *why* submission is closed without an owner session.
 */
readinessRouter.get("/health/readiness", async (_req, res) => {
  const readiness = computeReadiness();
  const reasons = [...readiness.reasons];
  let enabled = readiness.analysisSubmissionEnabled;
  if (enabled) {
    const gateway = await gatewayReachable();
    if (!gateway.ok) {
      enabled = false;
      if (gateway.reason) reasons.push(gateway.reason);
    }
  }
  if (!enabled) {
    console.warn(`[chelcoach-readiness] analysisSubmission=disabled reasons=${reasons.join(",") || "-"}`);
  }
  res.setHeader("Cache-Control", "no-store");
  res.status(enabled ? 200 : 503).json({ analysisSubmission: enabled ? "enabled" : "disabled" });
});
