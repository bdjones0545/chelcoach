/**
 * Provider factory — explicit selection, no silent downgrade.
 */
import {
  loadScottyProviderConfig,
  providerConfigDiagnostics,
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

export function createScottyProvider(config?: ScottyProviderConfig): ScottyProvider {
  const cfg = config ?? loadScottyProviderConfig();
  console.log(
    "[chelcoach-provider] event=provider_selected",
    Object.entries(providerConfigDiagnostics(cfg))
      .map(([k, v]) => `${k}=${v}`)
      .join(" "),
  );

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
