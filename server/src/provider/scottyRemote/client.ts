/**
 * HTTP client for the Scottie gateway on orgo-desktop (contract `chelcoach-analysis-v1`).
 *
 * Wire format, verified against the gateway's own `auth.py` / `server.py`:
 *   Authorization: Bearer <SCOTTY_API_KEY>
 *   X-ChelCoach-Timestamp: <unix ms>
 *   X-ChelCoach-Signature: t=<unix ms>,sha256=<hex hmac_sha256(secret, "{ts}.{METHOD}.{path}." + rawBody)>
 * GETs sign an empty body. The gateway keeps a replay cache keyed on (ts, method, path, sig).
 *
 * Routes: POST /v1/analyze · GET /v1/jobs/{id} · GET /v1/jobs/{id}/report ·
 *         POST /v1/jobs/{id}/confirm-player · POST /v1/jobs/{id}/cancel
 */
import { createHmac } from "node:crypto";
import { ProviderError } from "../errors";

export const SCOTTIE_CONTRACT_VERSION = "chelcoach-analysis-v1";
export const SCOTTIE_RUBRIC_VERSION = "chelcoach-rubric-v1";

export interface ScottieClientConfig {
  baseUrl: string;
  apiKey: string;
  signingSecret: string;
  /** Per-request timeout for status/report reads. */
  statusTimeoutMs: number;
  /** Timeout for the frame-bearing analyze request. */
  requestTimeoutMs: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export interface ScottieFrame {
  timestamp: number;
  jpegBase64: string;
}

export interface ScottieAnalyzeRequest {
  jobId: string;
  clipId: string;
  idempotencyKey: string;
  metadata: Record<string, string | number | boolean | null>;
  gameplayContext: Record<string, unknown>;
  frames: ScottieFrame[];
}

/** Public job envelope as returned by `job_response_public` (loosely typed on purpose). */
export interface ScottieJob {
  jobId: string;
  clipId: string;
  status: string;
  stage?: string;
  phaseProgress?: number;
  errorCode?: string;
  errorMessage?: string;
  requiresUserConfirmation?: boolean;
  controlledPlayer?: Record<string, unknown>;
  confirmationPrompt?: { candidates?: unknown[] };
  report?: Record<string, unknown>;
  usage?: Record<string, unknown>;
  providerMetadata?: Record<string, unknown>;
  completedAt?: string;
  updatedAt?: string;
  deduplicated?: boolean;
}

export function signScottieRequest(input: {
  secret: string;
  method: string;
  path: string;
  rawBody: string;
  timestampMs: number;
}): { timestamp: string; signature: string } {
  const method = input.method.toUpperCase();
  const path = input.path.startsWith("/") ? input.path : `/${input.path}`;
  const digest = createHmac("sha256", input.secret)
    .update(`${input.timestampMs}.${method}.${path}.`)
    .update(input.rawBody)
    .digest("hex");
  return { timestamp: String(input.timestampMs), signature: `t=${input.timestampMs},sha256=${digest}` };
}

function providerErrorFor(status: number, reason: string, retryableHint?: boolean): ProviderError {
  const base = { provider: "scotty" as const };
  if (status === 401 || status === 403) {
    return new ProviderError("PROVIDER_MISCONFIGURED", `Scottie rejected credentials (${reason}).`, "authentication", {
      ...base,
      retryable: false,
      httpStatus: status,
    });
  }
  if (status === 429) {
    return new ProviderError("RATE_LIMITED", "Scottie is rate limiting requests.", "rate_limit", {
      ...base,
      retryable: true,
      httpStatus: status,
    });
  }
  if (status === 404) {
    return new ProviderError("ANALYSIS_FAILED", "Scottie does not know this job.", "validation", {
      ...base,
      retryable: false,
      httpStatus: status,
    });
  }
  if (status === 409) {
    return new ProviderError("REPORT_NOT_READY", "Scottie report is not ready.", "validation", {
      ...base,
      retryable: true,
      httpStatus: status,
    });
  }
  if (status === 413 || status === 400) {
    return new ProviderError("INVALID_REQUEST", `Scottie rejected the request (${reason}).`, "validation", {
      ...base,
      retryable: false,
      httpStatus: status,
    });
  }
  if (status >= 500 || status === 503) {
    return new ProviderError("PROVIDER_UNAVAILABLE", `Scottie unavailable (${status}).`, "provider_unavailable", {
      ...base,
      retryable: true,
      httpStatus: status,
    });
  }
  return new ProviderError("ANALYSIS_FAILED", `Scottie error (${status}: ${reason}).`, "permanent_failure", {
    ...base,
    retryable: retryableHint ?? false,
    httpStatus: status,
  });
}

export class ScottieClient {
  constructor(private cfg: ScottieClientConfig) {}

  private async call<T>(method: "GET" | "POST", path: string, body?: unknown, timeoutMs?: number): Promise<{ status: number; body: T }> {
    const rawBody = body === undefined ? "" : JSON.stringify(body);
    const ts = (this.cfg.now ?? Date.now)();
    const signed = signScottieRequest({ secret: this.cfg.signingSecret, method, path, rawBody, timestampMs: ts });
    const fetchImpl = this.cfg.fetchImpl ?? fetch;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs ?? this.cfg.statusTimeoutMs);
    let res: Response;
    try {
      res = await fetchImpl(`${this.cfg.baseUrl.replace(/\/$/, "")}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.cfg.apiKey}`,
          "X-ChelCoach-Timestamp": signed.timestamp,
          "X-ChelCoach-Signature": signed.signature,
          ...(rawBody ? { "Content-Type": "application/json" } : {}),
          "User-Agent": "chelcoach-api/scotty-remote",
        },
        body: rawBody || undefined,
        signal: controller.signal,
      });
    } catch (err) {
      const aborted = (err as { name?: string }).name === "AbortError";
      throw new ProviderError(
        aborted ? "ANALYSIS_TIMEOUT" : "PROVIDER_UNAVAILABLE",
        aborted ? "Scottie did not respond in time." : "Scottie is unreachable.",
        aborted ? "timeout" : "network",
        { provider: "scotty", retryable: true, cause: err },
      );
    } finally {
      clearTimeout(timer);
    }
    const text = await res.text();
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }
    if (!res.ok) {
      const reason = (parsed as { reason?: string; error?: string; message?: string } | null);
      throw providerErrorFor(res.status, reason?.reason ?? reason?.error ?? reason?.message ?? res.statusText);
    }
    if (parsed === null || typeof parsed !== "object") {
      throw new ProviderError("REPORT_VALIDATION_FAILED", "Scottie returned a non-JSON body.", "invalid_response", {
        provider: "scotty",
        retryable: true,
      });
    }
    return { status: res.status, body: parsed as T };
  }

  async analyze(req: ScottieAnalyzeRequest): Promise<ScottieJob> {
    const body = {
      jobId: req.jobId,
      clipId: req.clipId,
      idempotencyKey: req.idempotencyKey,
      contractVersion: SCOTTIE_CONTRACT_VERSION,
      rubricVersion: SCOTTIE_RUBRIC_VERSION,
      metadata: req.metadata,
      gameplayContext: req.gameplayContext,
      frames: req.frames.map((f) => ({ timestamp: f.timestamp, jpegBase64: f.jpegBase64 })),
    };
    return (await this.call<ScottieJob>("POST", "/v1/analyze", body, this.cfg.requestTimeoutMs)).body;
  }

  async getJob(jobId: string): Promise<ScottieJob> {
    return (await this.call<ScottieJob>("GET", `/v1/jobs/${encodeURIComponent(jobId)}`)).body;
  }

  async getReport(jobId: string): Promise<ScottieJob> {
    return (await this.call<ScottieJob>("GET", `/v1/jobs/${encodeURIComponent(jobId)}/report`)).body;
  }

  async confirmPlayer(jobId: string, confirmation: Record<string, unknown>): Promise<ScottieJob> {
    return (await this.call<ScottieJob>("POST", `/v1/jobs/${encodeURIComponent(jobId)}/confirm-player`, confirmation)).body;
  }

  async cancel(jobId: string): Promise<ScottieJob> {
    return (await this.call<ScottieJob>("POST", `/v1/jobs/${encodeURIComponent(jobId)}/cancel`, {})).body;
  }

  async health(): Promise<{ ok: boolean; status: number; provider?: string }> {
    const fetchImpl = this.cfg.fetchImpl ?? fetch;
    try {
      const res = await fetchImpl(`${this.cfg.baseUrl.replace(/\/$/, "")}/ready`, {
        signal: AbortSignal.timeout(this.cfg.statusTimeoutMs),
      });
      const body = (await res.json().catch(() => ({}))) as { provider?: string };
      return { ok: res.ok, status: res.status, provider: body.provider };
    } catch {
      return { ok: false, status: 0 };
    }
  }
}
