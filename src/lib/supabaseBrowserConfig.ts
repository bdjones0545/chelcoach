/**
 * Frontend-safe Supabase Auth configuration status (Step 10.1B / Vercel).
 * Does not instantiate a client and never reads server-only secrets.
 */

export type SupabaseClientStatus =
  | { configured: true }
  | {
      configured: false;
      reason: "missing_url" | "missing_anon_key" | "invalid_url";
    };

export type SupabaseBrowserConfig = {
  url: string;
  anonKey: string;
};

/** Safe message for production users — no env var names or URLs. */
export const AUTH_UNAVAILABLE_USER_MESSAGE =
  "Sign-in is temporarily unavailable because authentication is not configured for this deployment.";

export function readSupabaseBrowserEnv(): { url: string; anonKey: string } {
  const url = (import.meta.env.VITE_SUPABASE_URL as string | undefined)?.trim() ?? "";
  const anonKey = (import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined)?.trim() ?? "";
  return { url, anonKey };
}

export function getSupabaseBrowserConfigStatus(
  env: { url: string; anonKey: string } = readSupabaseBrowserEnv(),
): SupabaseClientStatus {
  if (!env.url) return { configured: false, reason: "missing_url" };
  if (!env.anonKey) return { configured: false, reason: "missing_anon_key" };
  if (!env.url.startsWith("https://") && !env.url.startsWith("http://localhost")) {
    return { configured: false, reason: "invalid_url" };
  }
  return { configured: true };
}

export function readSupabaseBrowserConfig(
  env: { url: string; anonKey: string } = readSupabaseBrowserEnv(),
): SupabaseBrowserConfig | null {
  const status = getSupabaseBrowserConfigStatus(env);
  if (!status.configured) return null;
  return { url: env.url, anonKey: env.anonKey };
}

export function isSupabaseBrowserConfigured(): boolean {
  return getSupabaseBrowserConfigStatus().configured;
}

/** User-facing copy. Production stays generic; development may name the missing Vite key. */
export function authUnavailableUserMessage(
  status: Extract<SupabaseClientStatus, { configured: false }>,
  isProduction: boolean = Boolean(import.meta.env.PROD),
): string {
  if (isProduction) return AUTH_UNAVAILABLE_USER_MESSAGE;
  switch (status.reason) {
    case "missing_url":
      return "Supabase Auth is not configured in this build (VITE_SUPABASE_URL is missing).";
    case "missing_anon_key":
      return "Supabase Auth is not configured in this build (VITE_SUPABASE_ANON_KEY is missing).";
    case "invalid_url":
      return "Supabase Auth is not configured in this build (VITE_SUPABASE_URL is invalid).";
  }
}

/** Dev-only console diagnostic — never logs key values. */
export function logSupabaseConfigDiagnostic(
  status: SupabaseClientStatus,
  log: Pick<Console, "warn"> = console,
): void {
  if (import.meta.env.PROD || status.configured) return;
  log.warn(`[chelcoach-auth] browser Supabase Auth unavailable: ${status.reason}`);
}
