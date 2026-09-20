/**
 * OAuth (Google) return-to handoff.
 * Supabase always sends the browser back to OAUTH_CALLBACK_PATH on the same origin (one allowlist
 * entry, no query string to match); the destination survives the round trip in sessionStorage.
 */
export const OAUTH_CALLBACK_PATH = "/auth/callback";
const OAUTH_RETURN_TO_KEY = "chelcoach.oauth.returnTo";

/** Only same-origin relative paths — prevent open redirects. */
export function safeRedirectTo(path: string): string {
  if (!path.startsWith("/") || path.startsWith("//")) return "/";
  if (path.includes("://")) return "/";
  return path;
}

export function rememberOAuthReturnTo(path: string): void {
  try {
    window.sessionStorage.setItem(OAUTH_RETURN_TO_KEY, safeRedirectTo(path));
  } catch {
    // Storage unavailable (private mode) — callback falls back to /upload.
  }
}

export function takeOAuthReturnTo(): string {
  try {
    const stored = window.sessionStorage.getItem(OAUTH_RETURN_TO_KEY);
    window.sessionStorage.removeItem(OAUTH_RETURN_TO_KEY);
    return stored ? safeRedirectTo(stored) : "/upload";
  } catch {
    return "/upload";
  }
}
