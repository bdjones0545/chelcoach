/**
 * Production readiness gate (Step 10).
 * Analysis submission is blocked in production until all required controls are ready.
 * Development/test remain usable for local and E2E flows.
 */
import type { ChelCoachConfig } from "./chelcoachConfig";
import { getChelCoachConfig, validateChelCoachConfig } from "./chelcoachConfig";

export type ChelCoachReadiness = {
  authReady: boolean;
  durableStorageReady: boolean;
  identificationPersistenceReady: boolean;
  retentionReady: boolean;
  mediaStorageReady: boolean;
  providerReady: boolean;
  callbackReady: boolean;
  securityControlsReady: boolean;
  analysisSubmissionEnabled: boolean;
  reasons: string[];
};

export function computeReadiness(config: ChelCoachConfig = getChelCoachConfig()): ChelCoachReadiness {
  const reasons: string[] = [];
  const validation = validateChelCoachConfig(config);
  for (const issue of validation.issues.filter((i) => i.severity === "critical")) {
    reasons.push(issue.code);
  }

  const authReady = config.isProduction
    ? config.auth.mode === "existing_auth" && config.auth.productionAuthReady
    : config.auth.mode !== "disabled" && config.auth.allowSessionMint;

  if (!authReady) {
    reasons.push(
      config.isProduction ? "PRODUCTION_AUTH_NOT_READY" : "AUTH_NOT_AVAILABLE",
    );
  }

  const durableStorageReady =
    config.storage.databaseUrlConfigured && !config.storage.forceMemoryRepos;
  if (!durableStorageReady) {
    reasons.push("DURABLE_DATABASE_REQUIRED");
  }

  const identificationPersistenceReady = durableStorageReady;
  if (!identificationPersistenceReady) {
    reasons.push("IDENTIFICATION_MEMORY_ONLY");
  }

  const retentionReady = durableStorageReady;
  if (!retentionReady) {
    reasons.push("RETENTION_NOT_DURABLE");
  }

  const mediaStorageReady = config.isProduction
    ? config.storage.mode === "object_storage" || config.storage.productionMediaStorageReady
    : true;
  if (!mediaStorageReady) {
    reasons.push("MEDIA_STORAGE_NOT_PRODUCTION_READY");
  }

  const providerBlocking = validation.issues.filter((i) =>
    [
      "SCOTTY_DISABLED",
      "SCOTTY_BASE_URL_MISSING",
      "SCOTTY_SIGNING_MISSING",
      "ANTHROPIC_IN_PRODUCTION",
      "FAKE_IN_PRODUCTION",
      "SIMULATOR_IN_PRODUCTION",
      "SIMULATOR_DISABLED",
      "UNSUPPORTED_PROVIDER",
    ].includes(i.code),
  );
  const providerReady = providerBlocking.length === 0;
  if (!providerReady) {
    reasons.push("PROVIDER_NOT_READY");
  }

  const callbackReady =
    !config.transport.callbacksEnabled || config.transport.callbackSigningConfigured;
  if (!callbackReady) {
    reasons.push("CALLBACK_NOT_READY");
  }

  const securityControlsReady =
    !config.isProduction ||
    (config.cors.allowedOrigins.length > 0 &&
      !config.internal.legacyUploadEnabled &&
      !config.internal.e2eMode);
  if (!securityControlsReady) {
    reasons.push("SECURITY_CONTROLS_INCOMPLETE");
  }

  const explicitEnable = process.env.CHELCOACH_ANALYSIS_SUBMISSION_ENABLED === "1";
  if (config.isProduction && !explicitEnable) {
    reasons.push("ANALYSIS_SUBMISSION_NOT_EXPLICITLY_ENABLED");
  }

  // Production: all durability + auth + explicit enable required.
  // Development/test: allow analysis when auth and provider are usable (memory OK for unit tests).
  const analysisSubmissionEnabled = config.isProduction
    ? authReady &&
      durableStorageReady &&
      identificationPersistenceReady &&
      retentionReady &&
      mediaStorageReady &&
      providerReady &&
      callbackReady &&
      securityControlsReady &&
      explicitEnable &&
      validation.ok
    : authReady && providerReady && callbackReady;

  return {
    authReady,
    durableStorageReady,
    identificationPersistenceReady,
    retentionReady,
    mediaStorageReady,
    providerReady,
    callbackReady,
    securityControlsReady,
    analysisSubmissionEnabled,
    reasons: [...new Set(reasons)],
  };
}

export function assertAnalysisSubmissionReady(
  config: ChelCoachConfig = getChelCoachConfig(),
  readiness: ChelCoachReadiness = computeReadiness(config),
): void {
  if (!readiness.analysisSubmissionEnabled) {
    const err = new Error("ANALYSIS_NOT_READY");
    (err as Error & { code: string; reasons: string[] }).code = "ANALYSIS_NOT_READY";
    (err as Error & { code: string; reasons: string[] }).reasons = readiness.reasons;
    throw err;
  }
}

/** Admin-safe readiness payload — no secrets or hostnames. */
export function readinessPublicView(
  readiness: ChelCoachReadiness,
): Record<string, string | boolean | string[]> {
  return {
    authentication: readiness.authReady ? "ready" : "not_ready",
    database: readiness.durableStorageReady ? "ready" : "not_ready",
    identificationPersistence: readiness.identificationPersistenceReady
      ? "ready"
      : "not_ready",
    retentionPersistence: readiness.retentionReady ? "ready" : "not_ready",
    mediaStorage: readiness.mediaStorageReady
      ? "ready"
      : "development_only_or_blocked",
    provider: readiness.providerReady ? "ready" : "disabled_or_misconfigured",
    callbacks: readiness.callbackReady ? "ready_or_disabled" : "misconfigured",
    analysisSubmission: readiness.analysisSubmissionEnabled ? "enabled" : "disabled",
    reasons: readiness.reasons,
  };
}
