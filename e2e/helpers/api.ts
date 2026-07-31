import { API_BASE, E2E_SECRET } from "./env";

export type Session = { token: string; ownerId: string };

async function e2ePost(path: string, body: unknown): Promise<Response> {
  return fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-chelcoach-e2e-secret": E2E_SECRET,
    },
    body: JSON.stringify(body),
  });
}

export async function createSession(): Promise<Session> {
  const res = await fetch(`${API_BASE}/api/session`, { method: "POST" });
  if (!res.ok) throw new Error(`session failed: ${res.status}`);
  return (await res.json()) as Session;
}

export async function setDurationOverride(durationSec: number | null): Promise<void> {
  const res = await e2ePost("/api/internal/e2e/duration-override", { durationSec });
  if (!res.ok) throw new Error(`duration override failed: ${res.status}`);
}

export async function setSimulatorScenario(scenario: string | null): Promise<void> {
  const res = await e2ePost("/api/internal/e2e/simulator-scenario", { scenario });
  if (!res.ok) throw new Error(`scenario override failed: ${res.status}`);
}

export async function setMaxUploadBytes(maxBytes: number | null): Promise<void> {
  const res = await e2ePost("/api/internal/e2e/max-upload-bytes", { maxBytes });
  if (!res.ok) throw new Error(`max-upload-bytes failed: ${res.status}`);
}

export async function revokeSessionToken(token: string): Promise<void> {
  const res = await e2ePost("/api/internal/e2e/revoke-session", { token });
  if (!res.ok) throw new Error(`revoke-session failed: ${res.status}`);
}

export async function restoreSessionToken(token: string, ownerId: string): Promise<void> {
  const res = await e2ePost("/api/internal/e2e/restore-session", { token, ownerId });
  if (!res.ok) throw new Error(`restore-session failed: ${res.status}`);
}

export async function setTimeoutInjection(
  value: "none" | "submission" | "status" | "report",
): Promise<void> {
  const res = await e2ePost("/api/internal/e2e/timeout-injection", { value });
  if (!res.ok) throw new Error(`timeout-injection failed: ${res.status}`);
}

export async function expireUpload(
  uploadId: string,
  mode: "pending" | "media" | "deleted" = "pending",
): Promise<void> {
  const res = await e2ePost("/api/internal/e2e/expire-upload", { uploadId, mode });
  if (!res.ok) throw new Error(`expire-upload failed: ${res.status}`);
}

export async function runE2eCleanup(uploadId: string): Promise<{ deleted: number }> {
  const res = await e2ePost("/api/internal/e2e/cleanup", { uploadId });
  if (!res.ok) throw new Error(`cleanup failed: ${res.status}`);
  return (await res.json()) as { deleted: number };
}

export async function resetE2eControls(): Promise<void> {
  await e2ePost("/api/internal/e2e/reset-controls", {});
}

export async function resetIdentification(uploadId?: string): Promise<void> {
  const res = await e2ePost("/api/internal/e2e/reset-identification", {
    uploadId: uploadId ?? null,
  });
  if (!res.ok) throw new Error(`reset-identification failed: ${res.status}`);
}

export async function reconcile(limit = 25, secret?: string): Promise<{
  status: number;
  body: Record<string, unknown>;
}> {
  const res = await fetch(`${API_BASE}/api/internal/analysis/reconcile`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(secret ? { "x-chelcoach-reconcile-secret": secret } : {}),
    },
    body: JSON.stringify({ limit }),
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, body };
}

export async function postCallback(body: unknown, signature?: string): Promise<{
  status: number;
  body: Record<string, unknown>;
}> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (signature) headers["x-scotty-signature"] = signature;
  const res = await fetch(`${API_BASE}/api/internal/scotty/callbacks`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

export async function apiJson<T>(
  path: string,
  init: RequestInit & { token?: string } = {},
): Promise<{ status: number; body: T }> {
  const headers = new Headers(init.headers);
  if (init.token) headers.set("authorization", `Bearer ${init.token}`);
  if (init.body && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  const res = await fetch(`${API_BASE}${path}`, { ...init, headers });
  const body = (await res.json().catch(() => ({}))) as T;
  return { status: res.status, body };
}
