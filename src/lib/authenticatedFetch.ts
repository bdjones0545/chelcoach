/**
 * Central authenticated fetch for ChelCoach API calls (Step 10.1B).
 * Attaches Supabase (or development) access tokens only to the ChelCoach API origin.
 */
import { API_BASE_URL } from "./apiBase";
import { getAccessTokenForApi } from "./authToken";

function isChelCoachApiUrl(input: RequestInfo | URL): boolean {
  let url: URL;
  try {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    url = new URL(raw, typeof window !== "undefined" ? window.location.origin : API_BASE_URL);
  } catch {
    return false;
  }
  let apiOrigin: string;
  try {
    apiOrigin = new URL(API_BASE_URL, typeof window !== "undefined" ? window.location.origin : undefined).origin;
  } catch {
    return false;
  }
  return url.origin === apiOrigin;
}

export type AuthenticatedFetchOptions = RequestInit & {
  /** When true, skip attaching Authorization (public endpoints). */
  skipAuth?: boolean;
};

/**
 * Fetch helper that attaches Bearer auth only for ChelCoach API origins.
 * Never attaches tokens to Supabase Storage, Scotty, or arbitrary hosts.
 */
export async function authenticatedFetch(
  input: RequestInfo | URL,
  init: AuthenticatedFetchOptions = {},
): Promise<Response> {
  const { skipAuth, headers: initHeaders, ...rest } = init;
  const headers = new Headers(initHeaders);

  if (!headers.has("X-ChelCoach-Requested-With")) {
    headers.set("X-ChelCoach-Requested-With", "chelcoach");
  }

  if (!skipAuth && isChelCoachApiUrl(input)) {
    const token = await getAccessTokenForApi();
    if (token) {
      headers.set("Authorization", `Bearer ${token}`);
    }
  }

  // Defense in depth: strip Authorization if somehow pointed off-origin.
  if (!isChelCoachApiUrl(input) && headers.has("Authorization")) {
    headers.delete("Authorization");
  }

  return fetch(input, { ...rest, headers });
}

export function isApiOriginAllowed(url: string): boolean {
  return isChelCoachApiUrl(url);
}
