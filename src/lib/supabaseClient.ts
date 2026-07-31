/**
 * Browser-only Supabase client (Step 10.1B).
 * Uses VITE_SUPABASE_URL + VITE_SUPABASE_ANON_KEY only — never the service role.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export type SupabaseBrowserConfig = {
  url: string;
  anonKey: string;
};

let client: SupabaseClient | null = null;

export function readSupabaseBrowserConfig(): SupabaseBrowserConfig | null {
  const url = (import.meta.env.VITE_SUPABASE_URL as string | undefined)?.trim() ?? "";
  const anonKey = (import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined)?.trim() ?? "";
  if (!url || !anonKey) return null;
  if (!url.startsWith("https://") && !url.startsWith("http://localhost")) return null;
  return { url, anonKey };
}

export function isSupabaseBrowserConfigured(): boolean {
  return readSupabaseBrowserConfig() !== null;
}

/** Create or return the singleton browser client. Null when Vite config is absent. */
export function getSupabaseBrowserClient(): SupabaseClient | null {
  const config = readSupabaseBrowserConfig();
  if (!config) return null;
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
}
