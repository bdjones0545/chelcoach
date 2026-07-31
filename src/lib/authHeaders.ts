/**
 * Shared browser → ChelCoach API headers.
 * Prefer authenticatedFetch for new code — it attaches tokens safely.
 */
import { getAccessTokenForApi } from "./authToken";

export async function authHeaders(token?: string): Promise<Record<string, string>> {
  const headers: Record<string, string> = {
    "X-ChelCoach-Requested-With": "chelcoach",
  };
  const resolved = token ?? (await getAccessTokenForApi());
  if (resolved) {
    headers.authorization = `Bearer ${resolved}`;
  }
  return headers;
}

export function jsonAuthHeaders(token: string): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    "X-ChelCoach-Requested-With": "chelcoach",
  };
}
