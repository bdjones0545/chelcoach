/**
 * Server-only Scotty / analysis provider configuration.
 * Never expose secrets or base URLs to the browser bundle.
 */
import { analysisProviderSchema, type AnalysisProvider } from "../scottyContract";
import type { SimulatorScenario } from "./simulator/scenarios";
import { isSimulatorScenario } from "./simulator/scenarios";

export interface ScottyProviderConfig {
  provider: AnalysisProvider;
  scottyEnabled: boolean;
  scottyBaseUrl: string;
  contractVersion: string;
  requestTimeoutMs: number;
  statusTimeoutMs: number;
  reportTimeoutMs: number;
  signingSecretConfigured: boolean;
  nodeEnv: string;
  /** Dev/CI fixture mode for FakeScottyProvider. */
  fakeScenario?: FakeProviderScenario;
  /** Local simulator enabled flag. */
  simulatorEnabled: boolean;
  /** Explicit override to allow simulator when NODE_ENV=production (staging/tests only). */
  simulatorAllowInProduction: boolean;
  /** Default simulator scenario (`auto` resolves from media class). */
  simulatorDefaultScenario: SimulatorScenario | "auto";
}

export type FakeProviderScenario =
  | "accept"
  | "completed"
  | "failed"
  | "timeout"
  | "invalid_response";

function intEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min || n > max) {
    throw new Error(`[chelcoach-provider] Invalid ${name}=${raw} (expected ${min}–${max}).`);
  }
  return Math.floor(n);
}

function boolEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  if (raw === "1" || raw.toLowerCase() === "true") return true;
  if (raw === "0" || raw.toLowerCase() === "false") return false;
  throw new Error(`[chelcoach-provider] Invalid ${name}=${raw} (expected true/false).`);
}

export class ProviderConfigError extends Error {
  constructor(
    public code: "PROVIDER_MISCONFIGURED",
    message: string,
  ) {
    super(message);
    this.name = "ProviderConfigError";
  }
}

/** Load and validate provider config. Never logs secrets. */
export function loadScottyProviderConfig(
  env: NodeJS.ProcessEnv = process.env,
): ScottyProviderConfig {
  const providerRaw = env.CHELCOACH_ANALYSIS_PROVIDER ?? "fake";
  const parsed = analysisProviderSchema.safeParse(providerRaw);
  if (!parsed.success) {
    throw new ProviderConfigError(
      "PROVIDER_MISCONFIGURED",
      `Unsupported CHELCOACH_ANALYSIS_PROVIDER="${providerRaw}". Use fake | simulator | direct_anthropic | scotty.`,
    );
  }
  const provider = parsed.data;
  const scottyEnabled = boolEnv("CHELCOACH_SCOTTIE_ENABLED", false);
  const scottyBaseUrl = (env.SCOTTY_BASE_URL ?? "").trim();
  const contractVersion = (env.SCOTTY_CONTRACT_VERSION ?? "1.0.0").trim();
  const requestTimeoutMs = intEnv("SCOTTY_REQUEST_TIMEOUT_MS", 30_000, 1_000, 300_000);
  const statusTimeoutMs = intEnv("SCOTTY_STATUS_TIMEOUT_MS", 10_000, 500, 120_000);
  const reportTimeoutMs = intEnv("SCOTTY_REPORT_TIMEOUT_MS", 30_000, 1_000, 300_000);
  const signingSecretConfigured = Boolean((env.SCOTTY_SIGNING_SECRET ?? "").trim());
  const nodeEnv = env.NODE_ENV ?? "development";
  const simulatorEnabled = boolEnv("CHELCOACH_SCOTTY_SIMULATOR_ENABLED", true);
  const simulatorAllowInProduction = boolEnv(
    "CHELCOACH_SCOTTY_SIMULATOR_ALLOW_IN_PRODUCTION",
    false,
  );
  const scenarioRaw = (env.SCOTTY_SIMULATOR_DEFAULT_SCENARIO ?? "auto").trim();
  const simulatorDefaultScenario: SimulatorScenario | "auto" =
    scenarioRaw === "auto"
      ? "auto"
      : isSimulatorScenario(scenarioRaw)
        ? scenarioRaw
        : "auto";

  if (provider === "scotty" && !scottyEnabled) {
    throw new ProviderConfigError(
      "PROVIDER_MISCONFIGURED",
      "CHELCOACH_ANALYSIS_PROVIDER=scotty requires CHELCOACH_SCOTTIE_ENABLED=true.",
    );
  }
  if (provider === "scotty" && !scottyBaseUrl) {
    throw new ProviderConfigError(
      "PROVIDER_MISCONFIGURED",
      "CHELCOACH_ANALYSIS_PROVIDER=scotty requires SCOTTY_BASE_URL.",
    );
  }
  if (provider === "scotty" && !signingSecretConfigured) {
    throw new ProviderConfigError(
      "PROVIDER_MISCONFIGURED",
      "CHELCOACH_ANALYSIS_PROVIDER=scotty requires SCOTTY_SIGNING_SECRET.",
    );
  }
  if (provider === "direct_anthropic" && nodeEnv === "production") {
    throw new ProviderConfigError(
      "PROVIDER_MISCONFIGURED",
      "direct_anthropic is development-only and blocked when NODE_ENV=production.",
    );
  }
  if (provider === "direct_anthropic" && nodeEnv !== "test") {
    console.warn(
      "[chelcoach-provider] WARNING: CHELCOACH_ANALYSIS_PROVIDER=direct_anthropic is development-only.",
    );
  }
  if (provider === "simulator") {
    if (nodeEnv === "production" && !simulatorAllowInProduction) {
      throw new ProviderConfigError(
        "PROVIDER_MISCONFIGURED",
        "simulator is blocked when NODE_ENV=production unless CHELCOACH_SCOTTY_SIMULATOR_ALLOW_IN_PRODUCTION=true.",
      );
    }
    if (!simulatorEnabled) {
      throw new ProviderConfigError(
        "PROVIDER_MISCONFIGURED",
        "CHELCOACH_ANALYSIS_PROVIDER=simulator requires CHELCOACH_SCOTTY_SIMULATOR_ENABLED=true.",
      );
    }
  }

  const fakeRaw = env.CHELCOACH_FAKE_PROVIDER_SCENARIO as FakeProviderScenario | undefined;
  const fakeScenario =
    fakeRaw && ["accept", "completed", "failed", "timeout", "invalid_response"].includes(fakeRaw)
      ? fakeRaw
      : undefined;

  return {
    provider,
    scottyEnabled,
    scottyBaseUrl,
    contractVersion,
    requestTimeoutMs,
    statusTimeoutMs,
    reportTimeoutMs,
    signingSecretConfigured,
    nodeEnv,
    fakeScenario,
    simulatorEnabled,
    simulatorAllowInProduction,
    simulatorDefaultScenario,
  };
}

/** Safe diagnostics — no secrets or full URLs. */
export function providerConfigDiagnostics(config: ScottyProviderConfig): Record<string, string | boolean | number> {
  return {
    provider: config.provider,
    scottyEnabled: config.scottyEnabled,
    scottyBaseUrlConfigured: Boolean(config.scottyBaseUrl),
    signingSecretConfigured: config.signingSecretConfigured,
    contractVersion: config.contractVersion,
    requestTimeoutMs: config.requestTimeoutMs,
    statusTimeoutMs: config.statusTimeoutMs,
    reportTimeoutMs: config.reportTimeoutMs,
    nodeEnv: config.nodeEnv,
    simulatorEnabled: config.simulatorEnabled,
  };
}
