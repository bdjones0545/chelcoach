/**
 * Browser-only Supabase client (Step 10.1B).
 * Uses VITE_SUPABASE_URL + VITE_SUPABASE_ANON_KEY only — never the service role.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  getSupabaseBrowserConfigStatus,
  logSupabaseConfigDiagnostic,
  readSupabaseBrowserConfig,
  type SupabaseBrowserConfig,
  type SupabaseClientStatus,
} from "./supabaseBrowserConfig";

export type { SupabaseBrowserConfig, SupabaseClientStatus };
export {
  getSupabaseBrowserConfigStatus,
  isSupabaseBrowserConfigured,
  readSupabaseBrowserConfig,
  authUnavailableUserMessage,
  AUTH_UNAVAILABLE_USER_MESSAGE,
} from "./supabaseBrowserConfig";

let client: SupabaseClient | null = null;
let loggedDiagnostic = false;

/** Create or return the singleton browser client. Null when Vite config is absent/invalid. */
export function getSupabaseBrowserClient(): SupabaseClient | null {
  const status = getSupabaseBrowserConfigStatus();
  if (!status.configured) {
    if (!loggedDiagnostic) {
      logSupabaseConfigDiagnostic(status);
      loggedDiagnostic = true;
    }
    return null;
  }
  const config = readSupabaseBrowserConfig();
  if (!config) return null;
  // Never create a client with empty strings.
  if (!config.url || !config.anonKey) return null;
  if (!client) {
    client = createClient(config.url, config.anonKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
        flowType: "pkce",
      },
    });
  }
  return client;
}

/** Test helper */
export function resetSupabaseBrowserClientForTests(): void {
  client = null;
  loggedDiagnostic = false;
}
