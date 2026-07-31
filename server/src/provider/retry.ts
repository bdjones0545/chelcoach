/**
 * Centralized retry classification — policy only; no long-running workers in Step 4.
 */
import type { ProviderErrorCategory } from "../scottyContract";

export interface RetryPolicy {
  maxSubmissionRetries: number;
  maxStatusRetries: number;
  maxReportRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  maxElapsedMs: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxSubmissionRetries: 2,
  maxStatusRetries: 3,
  maxReportRetries: 3,
  baseDelayMs: 250,
  maxDelayMs: 8_000,
  maxElapsedMs: 30_000,
};

const RETRYABLE_HTTP = new Set([429, 502, 503, 504]);

export function isRetryableHttpStatus(status: number): boolean {
  return RETRYABLE_HTTP.has(status);
}

export function isRetryableCategory(category: ProviderErrorCategory): boolean {
  return (
    category === "rate_limit" ||
    category === "timeout" ||
    category === "network" ||
    category === "provider_unavailable"
  );
}

/** Non-retryable categories (contract / auth / permanent). */
export function isNonRetryableCategory(category: ProviderErrorCategory): boolean {
  return (
    category === "configuration" ||
    category === "authentication" ||
    category === "authorization" ||
    category === "validation" ||
    category === "contract_mismatch" ||
    category === "invalid_response" ||
    category === "permanent_failure"
  );
}

export function classifyHttpStatus(status: number): ProviderErrorCategory {
  if (status === 401) return "authentication";
  if (status === 403) return "authorization";
  if (status === 429) return "rate_limit";
  if (status === 408 || status === 504) return "timeout";
  if (status === 502 || status === 503) return "provider_unavailable";
  if (status >= 400 && status < 500) return "validation";
  if (status >= 500) return "provider_unavailable";
  return "permanent_failure";
}

/** Exponential backoff with full jitter (bounded). */
export function nextRetryDelayMs(attempt: number, policy: RetryPolicy = DEFAULT_RETRY_POLICY): number {
  const exp = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** Math.max(0, attempt));
  return Math.floor(Math.random() * exp);
}
