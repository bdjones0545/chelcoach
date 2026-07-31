/**
 * Selects and caches the production auth provider for the configured mode.
 */
import { getChelCoachConfig, type ChelCoachConfig } from "../config/chelcoachConfig";
import {
  createSupabaseAuthProvider,
  type SupabaseAuthConfig,
} from "./supabaseAuthProvider";
import type { ProductionAuthProvider } from "./types";
import { AuthFailure } from "./types";

let override: ProductionAuthProvider | null = null;
let cached: ProductionAuthProvider | null = null;
let cachedForMode: string | null = null;

export function setProductionAuthProviderForTests(
  provider: ProductionAuthProvider | null,
): void {
  override = provider;
  cached = null;
  cachedForMode = null;
}

export function resetProductionAuthForTests(): void {
  override = null;
  cached = null;
  cachedForMode = null;
}

function supabaseConfigFromEnv(env: NodeJS.ProcessEnv = process.env): SupabaseAuthConfig {
  return {
    url: (env.SUPABASE_URL ?? "").trim(),
    anonKey: (env.SUPABASE_ANON_KEY ?? "").trim(),
  };
}

export function isSupabaseAuthMode(config: ChelCoachConfig = getChelCoachConfig()): boolean {
  return config.auth.mode === "supabase_auth";
}

export function getProductionAuthProvider(
  config: ChelCoachConfig = getChelCoachConfig(),
): ProductionAuthProvider {
  if (override) return override;
  if (!isSupabaseAuthMode(config)) {
    throw new AuthFailure(
      "AUTH_PROVIDER_UNAVAILABLE",
      "Production auth provider is not active.",
      false,
    );
  }
  const modeKey = `${config.auth.mode}:${config.auth.supabaseUrlConfigured}`;
  if (cached && cachedForMode === modeKey) return cached;
  if (!config.auth.supabaseUrlConfigured || !config.auth.supabaseAnonConfigured) {
    throw new AuthFailure(
      "AUTH_PROVIDER_UNAVAILABLE",
      "Supabase Auth is not configured.",
      true,
    );
  }
  cached = createSupabaseAuthProvider(supabaseConfigFromEnv());
  cachedForMode = modeKey;
  return cached;
}
