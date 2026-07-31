/**
 * Provider factory — explicit selection, no silent downgrade.
 * Job synchronization must use the provider recorded on the job, not only the global default.
 */
import type { AnalysisProvider } from "../scottyContract";
import {
  loadScottyProviderConfig,
  providerConfigDiagnostics,
  ProviderConfigError,
  type ScottyProviderConfig,
} from "./config";
import { DirectAnthropicProvider } from "./directAnthropicProvider";
import { FakeScottyProvider } from "./fakeProvider";
import { HttpScottyProvider } from "./httpScottyProvider";
import { SimulatorScottyProvider } from "./simulator/simulatorProvider";
import { NoopScottyRequestSigner, UnconfiguredHmacScottyRequestSigner } from "./signer";
import type { ScottyProvider } from "./types";

let cached: ScottyProvider | null = null;
let cachedConfig: ScottyProviderConfig | null = null;

function buildProvider(cfg: ScottyProviderConfig): ScottyProvider {
  switch (cfg.provider) {
    case "fake":
      return new FakeScottyProvider(cfg.fakeScenario ?? "accept");
    case "simulator":
      return new SimulatorScottyProvider({
        defaultScenario: cfg.simulatorDefaultScenario,
      });
    case "direct_anthropic":
      return new DirectAnthropicProvider();
    case "scotty":
      return new HttpScottyProvider(
        cfg,
        cfg.signingSecretConfigured
          ? new UnconfiguredHmacScottyRequestSigner(true)
          : new NoopScottyRequestSigner(),
      );
    default: {
      const _exhaustive: never = cfg.provider;
      throw new Error(`Unsupported provider: ${_exhaustive}`);
    }
  }
}

export function createScottyProvider(config?: ScottyProviderConfig): ScottyProvider {
  const cfg = config ?? loadScottyProviderConfig();
  console.log(
    "[chelcoach-provider] event=provider_selected",
    Object.entries(providerConfigDiagnostics(cfg))
      .map(([k, v]) => `${k}=${v}`)
      .join(" "),
  );
  return buildProvider(cfg);
}

/**
 * Create/lookup a provider for a job's recorded mode after restart.
 * Never silently remaps to another provider.
 * Prefer the process-cached provider when its mode matches (tests + single-mode servers).
 */
export function createScottyProviderForMode(mode: AnalysisProvider): ScottyProvider {
  if (cached && cached.mode === mode) return cached;
  const base = loadScottyProviderConfig();
  if (mode === "simulator") {
    if (base.nodeEnv === "production" && !base.simulatorAllowInProduction) {
      throw new ProviderConfigError(
        "PROVIDER_MISCONFIGURED",
        "Recorded provider=simulator is blocked in production.",
      );
    }
    if (!base.simulatorEnabled) {
      throw new ProviderConfigError(
        "PROVIDER_MISCONFIGURED",
        "Recorded provider=simulator is disabled.",
      );
    }
  }
  if (mode === "direct_anthropic" && base.nodeEnv === "production") {
    throw new ProviderConfigError(
      "PROVIDER_MISCONFIGURED",
      "Recorded provider=direct_anthropic is blocked in production.",
    );
  }
  if (mode === "scotty" && (!base.scottyEnabled || !base.scottyBaseUrl)) {
    throw new ProviderConfigError(
      "PROVIDER_MISCONFIGURED",
      "Recorded provider=scotty is not configured.",
    );
  }
  return buildProvider({ ...base, provider: mode });
}

export function getScottyProvider(): ScottyProvider {
  if (!cached) {
    cachedConfig = loadScottyProviderConfig();
    cached = createScottyProvider(cachedConfig);
  }
  return cached;
}

export function setScottyProviderForTests(provider: ScottyProvider | null): void {
  cached = provider;
}

export function resetScottyProviderForTests(): void {
  cached = null;
  cachedConfig = null;
}

export function getCachedProviderConfig(): ScottyProviderConfig | null {
  return cachedConfig;
}
