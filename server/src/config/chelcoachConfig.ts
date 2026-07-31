/**
 * Central server-only ChelCoach configuration (Step 10).
 * Route/service code should prefer this loader over scattered process.env reads.
 * Never expose this object (or secrets) to the browser bundle.
 */
import { analysisProviderSchema, type AnalysisProvider } from "../scottyContract";
import { isSimulatorScenario, type SimulatorScenario } from "../provider/simulator/scenarios";

/**
 * Auth modes (Step 10.1B):
 * - development_session — opaque local/E2E sessions
 * - supabase_auth — production Supabase Auth (Bearer access token)
 * - existing_auth — accepted as an alias for supabase_auth when
 *   CHELCOACH_EXISTING_AUTH_PROVIDER=supabase
 * - disabled — all authenticated routes unavailable
 */
export type AuthMode = "development_session" | "supabase_auth" | "existing_auth" | "disabled";
export type ExistingAuthProvider = "supabase" | "none";
export type MediaStorageMode =
  | "local_disk"
  | "memory"
  | "object_storage"
  | "supabase_storage";

export interface ChelCoachConfig {
  nodeEnv: string;
  isProduction: boolean;
  isTest: boolean;

  auth: {
    /** Normalized mode: existing_auth+supabase → supabase_auth. */
    mode: "development_session" | "supabase_auth" | "disabled";
    /** Raw configured mode before alias normalization (for diagnostics). */
    configuredMode: AuthMode;
    existingAuthProvider: ExistingAuthProvider;
    productionAuthReady: boolean;
    sessionTtlMs: number;
    allowSessionMint: boolean;
    supabaseUrlConfigured: boolean;
    supabaseAnonConfigured: boolean;
    /** Service role present (server-only; never required for normal JWT verify). */
    supabaseServiceRoleConfigured: boolean;
  };

  provider: {
    provider: AnalysisProvider;
    scottyEnabled: boolean;
    scottyBaseUrl: string;
    signingSecretConfigured: boolean;
    contractVersion: string;
    requestTimeoutMs: number;
    statusTimeoutMs: number;
    reportTimeoutMs: number;
    simulatorEnabled: boolean;
    simulatorAllowInProduction: boolean;
    simulatorDefaultScenario: SimulatorScenario | "auto";
    fakeScenario?: string;
  };

  transport: {
    remoteTransportEnabled: boolean;
    callbacksEnabled: boolean;
    callbackSigningConfigured: boolean;
  };

  retention: {
    ready: boolean;
  };

  storage: {
    mode: MediaStorageMode;
    productionMediaStorageReady: boolean;
    databaseUrlConfigured: boolean;
    forceMemoryRepos: boolean;
    gameplayBucket: string;
    derivedMediaBucket: string;
    supabaseStorageConfigured: boolean;
  };

  internal: {
    reconcileSecretConfigured: boolean;
    cleanupSecretConfigured: boolean;
    e2eMode: boolean;
    e2eSecretConfigured: boolean;
    legacyUploadEnabled: boolean;
  };

  cors: {
    allowedOrigins: string[];
    credentials: boolean;
  };

  quotas: {
    maxActiveJobsPerUser: number;
    maxDailySubmissionsPerUser: number;
    maxConcurrentUploadsPerUser: number;
    maxPendingUploadsPerUser: number;
  };

  secrets: {
    sessionSecretConfigured: boolean;
    reconcileSecret: string;
    cleanupSecret: string;
    e2eSecret: string;
    callbackSecret: string;
    scottySigningSecret: string;
  };
}

export interface ConfigValidationIssue {
  code: string;
  message: string;
  severity: "critical" | "high" | "medium";
}

export interface ConfigValidationResult {
  ok: boolean;
  issues: ConfigValidationIssue[];
}

export class ChelCoachConfigError extends Error {
  constructor(
    public code: string,
    message: string,
    public issues: ConfigValidationIssue[] = [],
  ) {
    super(message);
    this.name = "ChelCoachConfigError";
  }
}

function boolEnv(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  if (raw === "1" || raw.toLowerCase() === "true") return true;
  if (raw === "0" || raw.toLowerCase() === "false") return false;
  throw new ChelCoachConfigError(
    "INVALID_BOOL",
    `Invalid ${name}=${raw} (expected true/false).`,
  );
}

function intEnv(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min || n > max) {
    throw new ChelCoachConfigError(
      "INVALID_INT",
      `Invalid ${name}=${raw} (expected ${min}–${max}).`,
    );
  }
  return Math.floor(n);
}

function parseAuthMode(raw: string | undefined): AuthMode {
  const v = (raw ?? "development_session").trim();
  if (
    v === "development_session" ||
    v === "supabase_auth" ||
    v === "existing_auth" ||
    v === "disabled"
  ) {
    return v;
  }
  throw new ChelCoachConfigError(
    "INVALID_AUTH_MODE",
    `Unsupported CHELCOACH_AUTH_MODE="${raw}". Use development_session | supabase_auth | existing_auth | disabled.`,
  );
}

function parseExistingAuthProvider(raw: string | undefined): ExistingAuthProvider {
  const v = (raw ?? "supabase").trim().toLowerCase();
  if (v === "supabase" || v === "none") return v;
  throw new ChelCoachConfigError(
    "INVALID_EXISTING_AUTH_PROVIDER",
    `Unsupported CHELCOACH_EXISTING_AUTH_PROVIDER="${raw}". Use supabase | none.`,
  );
}

/** Normalize configured mode to the runtime auth mode. */
export function normalizeAuthMode(
  configured: AuthMode,
  existingAuthProvider: ExistingAuthProvider,
): "development_session" | "supabase_auth" | "disabled" {
  if (configured === "supabase_auth") return "supabase_auth";
  if (configured === "existing_auth") {
    if (existingAuthProvider !== "supabase") {
      throw new ChelCoachConfigError(
        "EXISTING_AUTH_PROVIDER_REQUIRED",
        'CHELCOACH_AUTH_MODE=existing_auth requires CHELCOACH_EXISTING_AUTH_PROVIDER=supabase.',
      );
    }
    return "supabase_auth";
  }
  if (configured === "disabled") return "disabled";
  return "development_session";
}

function parseStorageMode(raw: string | undefined, env: NodeJS.ProcessEnv): MediaStorageMode {
  const v = (raw ?? "").trim();
  if (
    v === "local_disk" ||
    v === "memory" ||
    v === "object_storage" ||
    v === "supabase_storage"
  ) {
    return v;
  }
  if (env.STORAGE_BACKEND === "replit") return "object_storage";
  if (env.STORAGE_BACKEND === "memory") return "memory";
  return "local_disk";
}

const PLACEHOLDER_SECRETS = new Set([
  "",
  "changeme",
  "secret",
  "password",
  "test",
  "placeholder",
  "xxxxx",
  "your-secret-here",
]);

function isPlaceholderSecret(value: string): boolean {
  return PLACEHOLDER_SECRETS.has(value.trim().toLowerCase());
}

let cached: ChelCoachConfig | undefined;

/** Load configuration from env. Does not validate production fail-closed rules. */
export function loadChelCoachConfig(env: NodeJS.ProcessEnv = process.env): ChelCoachConfig {
  const nodeEnv = env.NODE_ENV ?? "development";
  const isProduction = nodeEnv === "production";
  const isTest = nodeEnv === "test";

  const providerRaw = env.CHELCOACH_ANALYSIS_PROVIDER ?? (isProduction ? "scotty" : "fake");
  const parsedProvider = analysisProviderSchema.safeParse(providerRaw);
  if (!parsedProvider.success) {
    throw new ChelCoachConfigError(
      "UNSUPPORTED_PROVIDER",
      `Unsupported CHELCOACH_ANALYSIS_PROVIDER="${providerRaw}". Use fake | simulator | direct_anthropic | scotty.`,
    );
  }

  const configuredAuthMode = parseAuthMode(env.CHELCOACH_AUTH_MODE);
  const existingAuthProvider = parseExistingAuthProvider(env.CHELCOACH_EXISTING_AUTH_PROVIDER);
  const authMode = normalizeAuthMode(configuredAuthMode, existingAuthProvider);
  const productionAuthReady = boolEnv(env, "CHELCOACH_PRODUCTION_AUTH_READY", false);
  const sessionTtlMs = intEnv(env, "CHELCOACH_SESSION_TTL_MS", 24 * 60 * 60 * 1000, 60_000, 30 * 24 * 60 * 60 * 1000);
  const supabaseUrl = (env.SUPABASE_URL ?? "").trim();
  const supabaseAnon = (env.SUPABASE_ANON_KEY ?? "").trim();
  const supabaseServiceRole = (env.SUPABASE_SERVICE_ROLE_KEY ?? "").trim();

  const scottyEnabled = boolEnv(env, "CHELCOACH_SCOTTIE_ENABLED", false);
  const scottyBaseUrl = (env.SCOTTY_BASE_URL ?? "").trim();
  const signingSecret = (env.SCOTTY_SIGNING_SECRET ?? "").trim();
  const simulatorEnabled = boolEnv(env, "CHELCOACH_SCOTTY_SIMULATOR_ENABLED", !isProduction);
  const simulatorAllowInProduction = boolEnv(
    env,
    "CHELCOACH_SCOTTY_SIMULATOR_ALLOW_IN_PRODUCTION",
    false,
  );
  const scenarioRaw = (env.SCOTTY_SIMULATOR_DEFAULT_SCENARIO ?? "auto").trim();
  const simulatorDefaultScenario: SimulatorScenario | "auto" =
    scenarioRaw === "auto"
      ? "auto"
      : isSimulatorScenario(scenarioRaw)
        ? scenarioRaw
        : (() => {
            throw new ChelCoachConfigError(
              "INVALID_SIMULATOR_SCENARIO",
              `Invalid SCOTTY_SIMULATOR_DEFAULT_SCENARIO="${scenarioRaw}".`,
            );
          })();

  const callbacksEnabled = boolEnv(env, "CHELCOACH_SCOTTY_CALLBACKS_ENABLED", false);
  const callbackSecret = (env.CHELCOACH_CALLBACK_SECRET ?? env.SCOTTY_CALLBACK_SECRET ?? "").trim();
  const remoteTransportEnabled = boolEnv(env, "CHELCOACH_REMOTE_TRANSPORT_ENABLED", false);

  const reconcileSecret = (env.CHELCOACH_RECONCILE_SECRET ?? "").trim();
  const cleanupSecret = (env.CHELCOACH_CLEANUP_SECRET ?? "").trim();
  const e2eSecret = (env.CHELCOACH_E2E_SECRET ?? "").trim();
  const e2eMode = env.CHELCOACH_E2E_MODE === "1";
  const sessionSecret = (env.CHELCOACH_SESSION_SECRET ?? "").trim();

  const storageMode = parseStorageMode(env.CHELCOACH_MEDIA_STORAGE_MODE, env);
  const productionMediaStorageReady = boolEnv(
    env,
    "CHELCOACH_PRODUCTION_MEDIA_STORAGE_READY",
    false,
  );
  const forceMemoryRepos =
    env.CHELCOACH_FORCE_MEMORY_REPOS === "1" || isTest;
  const gameplayBucket = (env.SUPABASE_GAMEPLAY_BUCKET ?? "chelcoach-gameplay").trim();
  const derivedMediaBucket = (
    env.SUPABASE_DERIVED_MEDIA_BUCKET ?? "chelcoach-derived-media"
  ).trim();
  const supabaseStorageConfigured =
    Boolean((env.SUPABASE_URL ?? "").trim()) &&
    Boolean((env.SUPABASE_ANON_KEY ?? "").trim()) &&
    Boolean((env.SUPABASE_SERVICE_ROLE_KEY ?? "").trim()) &&
    Boolean(gameplayBucket) &&
    Boolean(derivedMediaBucket);

  const origins = (env.CORS_ORIGIN ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const legacyUploadEnabled = boolEnv(
    env,
    "CHELCOACH_LEGACY_UPLOAD_ENABLED",
    !isProduction,
  );

  const allowSessionMint =
    authMode === "development_session" &&
    (!isProduction ||
      (productionAuthReady && boolEnv(env, "CHELCOACH_ALLOW_DEV_SESSIONS_IN_PRODUCTION", false)));

  const config: ChelCoachConfig = {
    nodeEnv,
    isProduction,
    isTest,
    auth: {
      mode: authMode,
      configuredMode: configuredAuthMode,
      existingAuthProvider,
      productionAuthReady,
      sessionTtlMs,
      allowSessionMint,
      supabaseUrlConfigured: Boolean(supabaseUrl) && !isPlaceholderSecret(supabaseUrl),
      supabaseAnonConfigured: Boolean(supabaseAnon) && !isPlaceholderSecret(supabaseAnon),
      supabaseServiceRoleConfigured:
        Boolean(supabaseServiceRole) && !isPlaceholderSecret(supabaseServiceRole),
    },
    provider: {
      provider: parsedProvider.data,
      scottyEnabled,
      scottyBaseUrl,
      signingSecretConfigured: Boolean(signingSecret) && !isPlaceholderSecret(signingSecret),
      contractVersion: (env.SCOTTY_CONTRACT_VERSION ?? "1.0.0").trim(),
      requestTimeoutMs: intEnv(env, "SCOTTY_REQUEST_TIMEOUT_MS", 30_000, 1_000, 300_000),
      statusTimeoutMs: intEnv(env, "SCOTTY_STATUS_TIMEOUT_MS", 10_000, 500, 120_000),
      reportTimeoutMs: intEnv(env, "SCOTTY_REPORT_TIMEOUT_MS", 30_000, 1_000, 300_000),
      simulatorEnabled,
      simulatorAllowInProduction,
      simulatorDefaultScenario,
      fakeScenario: env.CHELCOACH_FAKE_PROVIDER_SCENARIO,
    },
    transport: {
      remoteTransportEnabled,
      callbacksEnabled,
      callbackSigningConfigured: Boolean(callbackSecret) && !isPlaceholderSecret(callbackSecret),
    },
    retention: {
      ready: Boolean((env.DATABASE_URL ?? "").trim()) && !forceMemoryRepos,
    },
    storage: {
      mode: storageMode,
      productionMediaStorageReady,
      databaseUrlConfigured: Boolean((env.DATABASE_URL ?? "").trim()),
      forceMemoryRepos,
      gameplayBucket,
      derivedMediaBucket,
      supabaseStorageConfigured,
    },
    internal: {
      reconcileSecretConfigured: Boolean(reconcileSecret) && !isPlaceholderSecret(reconcileSecret),
      cleanupSecretConfigured: Boolean(cleanupSecret) && !isPlaceholderSecret(cleanupSecret),
      e2eMode,
      e2eSecretConfigured: Boolean(e2eSecret) && !isPlaceholderSecret(e2eSecret),
      legacyUploadEnabled,
    },
    cors: {
      allowedOrigins: origins,
      credentials: boolEnv(env, "CORS_CREDENTIALS", false),
    },
    quotas: {
      maxActiveJobsPerUser: intEnv(env, "CHELCOACH_MAX_ACTIVE_JOBS_PER_USER", 5, 1, 100),
      maxDailySubmissionsPerUser: intEnv(env, "CHELCOACH_MAX_DAILY_SUBMISSIONS_PER_USER", 20, 1, 1000),
      maxConcurrentUploadsPerUser: intEnv(env, "CHELCOACH_MAX_CONCURRENT_UPLOADS_PER_USER", 3, 1, 50),
      maxPendingUploadsPerUser: intEnv(env, "CHELCOACH_MAX_PENDING_UPLOADS_PER_USER", 3, 1, 50),
    },
    secrets: {
      sessionSecretConfigured: Boolean(sessionSecret) && !isPlaceholderSecret(sessionSecret),
      reconcileSecret,
      cleanupSecret,
      e2eSecret,
      callbackSecret,
      scottySigningSecret: signingSecret,
    },
  };

  return config;
}

/** Fail-closed validation — production and any environment with analysis enabled. */
export function validateChelCoachConfig(config: ChelCoachConfig): ConfigValidationResult {
  const issues: ConfigValidationIssue[] = [];

  if (config.internal.e2eMode && config.isProduction) {
    issues.push({
      code: "E2E_IN_PRODUCTION",
      message: "CHELCOACH_E2E_MODE cannot be enabled when NODE_ENV=production.",
      severity: "critical",
    });
  }

  if (config.isProduction && config.auth.mode === "development_session") {
    if (config.auth.productionAuthReady) {
      issues.push({
        code: "DEV_AUTH_CLAIMED_READY",
        message:
          "CHELCOACH_PRODUCTION_AUTH_READY=true is incompatible with CHELCOACH_AUTH_MODE=development_session.",
        severity: "critical",
      });
    }
  }

  if (config.isProduction && config.auth.mode === "disabled") {
    issues.push({
      code: "AUTH_DISABLED_IN_PRODUCTION",
      message: "CHELCOACH_AUTH_MODE=disabled is not allowed in production.",
      severity: "critical",
    });
  }

  if (config.auth.mode === "supabase_auth") {
    if (!config.auth.supabaseUrlConfigured) {
      issues.push({
        code: "SUPABASE_URL_MISSING",
        message: "CHELCOACH_AUTH_MODE=supabase_auth requires SUPABASE_URL.",
        severity: "critical",
      });
    }
    if (!config.auth.supabaseAnonConfigured) {
      issues.push({
        code: "SUPABASE_ANON_KEY_MISSING",
        message: "CHELCOACH_AUTH_MODE=supabase_auth requires SUPABASE_ANON_KEY.",
        severity: "critical",
      });
    }
  }

  if (
    config.isProduction &&
    config.auth.productionAuthReady &&
    config.auth.mode !== "supabase_auth"
  ) {
    issues.push({
      code: "PRODUCTION_AUTH_READY_WITHOUT_SUPABASE",
      message:
        "CHELCOACH_PRODUCTION_AUTH_READY=true requires CHELCOACH_AUTH_MODE=supabase_auth (or existing_auth with provider=supabase).",
      severity: "critical",
    });
  }

  if (config.isProduction && config.cors.allowedOrigins.length === 0) {
    issues.push({
      code: "CORS_ORIGINS_REQUIRED",
      message: "Production requires explicit CORS_ORIGIN (comma-separated). Wildcard credentialed CORS is rejected.",
      severity: "high",
    });
  }

  if (config.cors.allowedOrigins.includes("*") && config.cors.credentials) {
    issues.push({
      code: "WILDCARD_CREDENTIALED_CORS",
      message: "CORS cannot use origin=* with credentials.",
      severity: "critical",
    });
  }

  const p = config.provider.provider;
  if (p === "scotty" && !config.provider.scottyEnabled) {
    issues.push({
      code: "SCOTTY_DISABLED",
      message: "provider=scotty requires CHELCOACH_SCOTTIE_ENABLED=true.",
      severity: "critical",
    });
  }
  if (p === "scotty" && !config.provider.scottyBaseUrl) {
    issues.push({
      code: "SCOTTY_BASE_URL_MISSING",
      message: "provider=scotty requires SCOTTY_BASE_URL.",
      severity: "critical",
    });
  }
  if (p === "scotty" && !config.provider.signingSecretConfigured) {
    issues.push({
      code: "SCOTTY_SIGNING_MISSING",
      message: "provider=scotty requires a non-placeholder SCOTTY_SIGNING_SECRET.",
      severity: "critical",
    });
  }
  if (p === "direct_anthropic" && config.isProduction) {
    issues.push({
      code: "ANTHROPIC_IN_PRODUCTION",
      message: "direct_anthropic is blocked in production.",
      severity: "critical",
    });
  }
  if (p === "fake" && config.isProduction) {
    issues.push({
      code: "FAKE_IN_PRODUCTION",
      message: "fake provider is blocked in production.",
      severity: "critical",
    });
  }
  if (
    p === "simulator" &&
    config.isProduction &&
    !config.provider.simulatorAllowInProduction
  ) {
    issues.push({
      code: "SIMULATOR_IN_PRODUCTION",
      message:
        "simulator is blocked in production unless CHELCOACH_SCOTTY_SIMULATOR_ALLOW_IN_PRODUCTION=true.",
      severity: "critical",
    });
  }
  if (p === "simulator" && !config.provider.simulatorEnabled) {
    issues.push({
      code: "SIMULATOR_DISABLED",
      message: "provider=simulator requires CHELCOACH_SCOTTY_SIMULATOR_ENABLED=true.",
      severity: "critical",
    });
  }

  if (config.transport.callbacksEnabled && !config.transport.callbackSigningConfigured) {
    issues.push({
      code: "CALLBACK_UNSIGNED",
      message: "Callbacks enabled without CHELCOACH_CALLBACK_SECRET (or SCOTTY_CALLBACK_SECRET).",
      severity: "critical",
    });
  }

  if (config.transport.remoteTransportEnabled && !config.provider.signingSecretConfigured) {
    issues.push({
      code: "TRANSPORT_UNSIGNED",
      message: "Remote transport enabled without SCOTTY_SIGNING_SECRET.",
      severity: "critical",
    });
  }

  if (config.isProduction && config.internal.legacyUploadEnabled) {
    issues.push({
      code: "LEGACY_UPLOAD_IN_PRODUCTION",
      message: "Legacy upload routes must be disabled in production (CHELCOACH_LEGACY_UPLOAD_ENABLED=false).",
      severity: "high",
    });
  }

  if (
    config.isProduction &&
    config.storage.mode === "local_disk" &&
    !config.storage.productionMediaStorageReady
  ) {
    // Not a startup failure by itself — readiness gate blocks analysis.
    issues.push({
      code: "LOCAL_DISK_NOT_PRODUCTION_READY",
      message:
        "local_disk media storage is not production-durable; use CHELCOACH_MEDIA_STORAGE_MODE=supabase_storage for production.",
      severity: "medium",
    });
  }

  if (config.storage.mode === "supabase_storage" && !config.storage.supabaseStorageConfigured) {
    issues.push({
      code: "STORAGE_NOT_CONFIGURED",
      message:
        "supabase_storage requires SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY, and bucket names.",
      severity: "critical",
    });
  }

  if (
    config.isProduction &&
    config.storage.productionMediaStorageReady &&
    config.storage.mode !== "supabase_storage"
  ) {
    issues.push({
      code: "MEDIA_STORAGE_READY_WITHOUT_SUPABASE",
      message:
        "CHELCOACH_PRODUCTION_MEDIA_STORAGE_READY=true requires CHELCOACH_MEDIA_STORAGE_MODE=supabase_storage.",
      severity: "critical",
    });
  }

  if (
    config.secrets.reconcileSecret &&
    config.secrets.cleanupSecret &&
    config.secrets.reconcileSecret === config.secrets.cleanupSecret
  ) {
    issues.push({
      code: "SHARED_INTERNAL_SECRETS",
      message: "Reconcile and cleanup secrets must be distinct.",
      severity: "high",
    });
  }

  if (
    config.secrets.scottySigningSecret &&
    (config.secrets.scottySigningSecret === config.secrets.reconcileSecret ||
      config.secrets.scottySigningSecret === config.secrets.cleanupSecret ||
      config.secrets.scottySigningSecret === config.secrets.callbackSecret)
  ) {
    issues.push({
      code: "REUSED_SIGNING_SECRET",
      message: "SCOTTY_SIGNING_SECRET must not be reused for internal or callback secrets.",
      severity: "high",
    });
  }

  const critical = issues.filter((i) => i.severity === "critical");
  return { ok: critical.length === 0, issues };
}

export function getChelCoachConfig(env: NodeJS.ProcessEnv = process.env): ChelCoachConfig {
  if (env === process.env && cached) return cached;
  const config = loadChelCoachConfig(env);
  if (env === process.env) cached = config;
  return config;
}

export function resetChelCoachConfigCacheForTests(): void {
  cached = undefined;
}

/** Assert config is safe to boot. Throws ChelCoachConfigError on critical issues. */
export function assertBootConfig(env: NodeJS.ProcessEnv = process.env): ChelCoachConfig {
  const config = loadChelCoachConfig(env);
  const result = validateChelCoachConfig(config);
  const blocking = result.issues.filter(
    (i) =>
      i.severity === "critical" ||
      (config.isProduction && i.severity === "high" && i.code !== "LOCAL_DISK_NOT_PRODUCTION_READY"),
  );
  // Production: fail on critical. High CORS/legacy fail in production.
  const fail =
    result.issues.filter((i) => i.severity === "critical").length > 0 ||
    (config.isProduction &&
      result.issues.some(
        (i) =>
          i.code === "CORS_ORIGINS_REQUIRED" ||
          i.code === "LEGACY_UPLOAD_IN_PRODUCTION" ||
          i.code === "SHARED_INTERNAL_SECRETS" ||
          i.code === "REUSED_SIGNING_SECRET",
      ));
  if (fail) {
    throw new ChelCoachConfigError(
      "CONFIG_INVALID",
      `ChelCoach configuration invalid: ${blocking.map((i) => i.code).join(", ")}`,
      result.issues,
    );
  }
  if (env === process.env) cached = config;
  return config;
}

/** Safe diagnostics — no secrets, hostnames, or raw env. */
export function configDiagnostics(config: ChelCoachConfig): Record<string, string | boolean | number> {
  return {
    nodeEnv: config.nodeEnv,
    authMode: config.auth.mode,
    configuredAuthMode: config.auth.configuredMode,
    existingAuthProvider: config.auth.existingAuthProvider,
    productionAuthReady: config.auth.productionAuthReady,
    allowSessionMint: config.auth.allowSessionMint,
    supabaseUrlConfigured: config.auth.supabaseUrlConfigured,
    supabaseAnonConfigured: config.auth.supabaseAnonConfigured,
    supabaseServiceRoleConfigured: config.auth.supabaseServiceRoleConfigured,
    provider: config.provider.provider,
    scottyEnabled: config.provider.scottyEnabled,
    simulatorEnabled: config.provider.simulatorEnabled,
    callbacksEnabled: config.transport.callbacksEnabled,
    remoteTransportEnabled: config.transport.remoteTransportEnabled,
    databaseConfigured: config.storage.databaseUrlConfigured,
    forceMemoryRepos: config.storage.forceMemoryRepos,
    mediaStorageMode: config.storage.mode,
    productionMediaStorageReady: config.storage.productionMediaStorageReady,
    gameplayBucket: config.storage.gameplayBucket,
    derivedMediaBucket: config.storage.derivedMediaBucket,
    supabaseStorageConfigured: config.storage.supabaseStorageConfigured,
    legacyUploadEnabled: config.internal.legacyUploadEnabled,
    e2eMode: config.internal.e2eMode,
    corsOriginCount: config.cors.allowedOrigins.length,
    reconcileSecretConfigured: config.internal.reconcileSecretConfigured,
    cleanupSecretConfigured: config.internal.cleanupSecretConfigured,
  };
}

/** Assert diagnostics payload never embeds connection strings. */
export function assertDiagnosticsSafe(payload: unknown): void {
  const text = JSON.stringify(payload);
  if (/postgres(?:ql)?:\/\//i.test(text)) {
    throw new ChelCoachConfigError("DIAGNOSTICS_LEAK", "Diagnostics must not include DATABASE_URL.");
  }
  if (/SERVICE_ROLE|SCOTTY_SIGNING_SECRET|password=/i.test(text)) {
    throw new ChelCoachConfigError("DIAGNOSTICS_LEAK", "Diagnostics must not include secrets.");
  }
}
