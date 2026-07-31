/**
 * Shared browser → ChelCoach API headers.
 * Includes CSRF custom header required for state-changing requests.
 */
export async function authHeaders(token?: string): Promise<Record<string, string>> {
  const headers: Record<string, string> = {
    "X-ChelCoach-Requested-With": "chelcoach",
  };
  if (token) {
    headers.authorization = `Bearer ${token}`;
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
