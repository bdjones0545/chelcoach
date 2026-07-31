/**
 * Resolve the current access token for ChelCoach API calls.
 * Supabase Auth when configured; otherwise development opaque session mint.
 */
import { API_BASE_URL } from "./apiBase";
import { isSupabaseBrowserConfigured, getSupabaseBrowserClient } from "./supabaseClient";

const DEV_TOKEN_KEY = "chelcoach_owner_token";

export function getStoredDevOwnerToken(): string | null {
  try {
    return localStorage.getItem(DEV_TOKEN_KEY);
  } catch {
    return null;
  }
}

export function storeDevOwnerToken(token: string): void {
  try {
    localStorage.setItem(DEV_TOKEN_KEY, token);
  } catch {
    /* ignore */
  }
}

export function clearDevOwnerToken(): void {
  try {
    localStorage.removeItem(DEV_TOKEN_KEY);
  } catch {
    /* ignore */
  }
}

/** Mint/reuse development opaque session (local/E2E only). */
export async function ensureDevelopmentSession(): Promise<string> {
  const existing = getStoredDevOwnerToken();
  if (existing) {
    const probe = await fetch(`${API_BASE_URL}/api/gameplay-profile`, {
      headers: {
        authorization: `Bearer ${existing}`,
        "X-ChelCoach-Requested-With": "chelcoach",
      },
    });
    if (probe.ok) return existing;
  }
  const res = await fetch(`${API_BASE_URL}/api/session`, {
    method: "POST",
    headers: { "X-ChelCoach-Requested-With": "chelcoach" },
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error === "SESSION_MINT_DISABLED" ? "SESSION_MINT_DISABLED" : "Failed to create session");
  }
  const body = (await res.json()) as { token: string };
  storeDevOwnerToken(body.token);
  return body.token;
}

/**
 * Token for API Authorization header.
 * Returns null when Supabase is configured but the user is signed out.
 */
export async function getAccessTokenForApi(): Promise<string | null> {
  if (isSupabaseBrowserConfigured()) {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return null;
    const { data, error } = await supabase.auth.getSession();
    if (error || !data.session?.access_token) return null;
    return data.session.access_token;
  }
  try {
    return await ensureDevelopmentSession();
  } catch {
    return null;
  }
}

/** @deprecated Prefer getAccessTokenForApi / authenticatedFetch */
export async function ensureOwnerSession(): Promise<string> {
  if (isSupabaseBrowserConfigured()) {
    const token = await getAccessTokenForApi();
    if (!token) throw new Error("AUTHENTICATION_REQUIRED");
    return token;
  }
  return ensureDevelopmentSession();
}
