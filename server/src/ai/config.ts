/**
 * Centralized AI-analysis configuration (Phase 4).
 * Secrets never logged; all bounds validated at load.
 */
function intEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min || n > max) {
    throw new Error(`[chelcoach-api] Invalid ${name}=${raw} (expected ${min}–${max}).`);
  }
  return Math.floor(n);
}

/**
 * Default model: Claude Sonnet 5 — vision + structured outputs, best speed/cost
 * balance for gameplay coaching (official API id `claude-sonnet-5`, docs 2026-06).
 * Override with ANTHROPIC_MODEL. Fallback policy documented in docs/ai-gameplay-analysis.md.
 */
export const aiConfig = {
  /** Anthropic API key — required for live AI; absent → ai_not_configured in live mode. */
  apiKey: process.env.ANTHROPIC_API_KEY?.trim() || "",
  /** Vision-capable model id (official Claude API). */
  model: process.env.ANTHROPIC_MODEL?.trim() || "claude-sonnet-5",
  /** Provider request timeout (ms). */
  requestTimeoutMs: intEnv("AI_REQUEST_TIMEOUT_MS", 90_000, 5_000, 300_000),
  /** Max provider attempts including the first try. Transient failures only. */
  maxAttempts: intEnv("AI_MAX_ATTEMPTS", 2, 1, 4),
  /** Base backoff before retry (ms); jitter applied. */
  retryBackoffMs: intEnv("AI_RETRY_BACKOFF_MS", 750, 100, 10_000),
  /** Max frames sent to the model (≤ media maxFrames). */
  maxFrames: intEnv("AI_MAX_FRAMES", 12, 1, 60),
  /** Per-image raw byte limit before base64 (JPEG). */
  maxImageBytes: intEnv("AI_MAX_IMAGE_BYTES", 1_500_000, 10_000, 10_000_000),
  /** Total raw image bytes across the request. */
  maxTotalImageBytes: intEnv("AI_MAX_TOTAL_IMAGE_BYTES", 12_000_000, 50_000, 30_000_000),
  /** Max output tokens for the structured report. */
  maxOutputTokens: intEnv("AI_MAX_OUTPUT_TOKENS", 8_192, 1_024, 32_768),
  /**
   * When "fake", always use the injected/fake provider (tests + smoke).
   * When "anthropic" (default), use Anthropic if a key is present.
   */
  provider: (process.env.AI_PROVIDER?.trim().toLowerCase() || "anthropic") as "anthropic" | "fake",
} as const;

export type AiConfig = typeof aiConfig;

/** Reload helpers for tests that mutate env. */
export function readApiKeyFromEnv(): string {
  return process.env.ANTHROPIC_API_KEY?.trim() || "";
}

export function readProviderFromEnv(): "anthropic" | "fake" {
  const raw = process.env.AI_PROVIDER?.trim().toLowerCase();
  if (raw === "fake") return "fake";
  return "anthropic";
}

export function isAiConfigured(): boolean {
  if (readProviderFromEnv() === "fake" || aiConfig.provider === "fake") return true;
  return Boolean(readApiKeyFromEnv() || aiConfig.apiKey);
}
