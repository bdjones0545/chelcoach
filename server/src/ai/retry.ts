/**
 * Bounded retry for transient AI provider failures.
 * Never retries auth, schema, content, or configuration errors infinitely.
 */
import { aiConfig } from "./config";
import { AiAnalysisError, toAiAnalysisError } from "./errors";

export interface RetryOptions {
  maxAttempts?: number;
  backoffMs?: number;
  signal?: AbortSignal;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      const err = new Error("aborted");
      err.name = "AbortError";
      reject(err);
      return;
    }
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        const err = new Error("aborted");
        err.name = "AbortError";
        reject(err);
      },
      { once: true },
    );
  });
}

function jitter(baseMs: number): number {
  const spread = Math.floor(baseMs * 0.4);
  return baseMs + Math.floor(Math.random() * (spread + 1));
}

export async function withAiRetries<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const maxAttempts = options.maxAttempts ?? aiConfig.maxAttempts;
  const backoffMs = options.backoffMs ?? aiConfig.retryBackoffMs;
  let last: AiAnalysisError | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (options.signal?.aborted) {
      throw new AiAnalysisError("AI_ABORTED", "aborted", { retryable: false });
    }
    try {
      return await fn();
    } catch (err) {
      const mapped = toAiAnalysisError(err);
      last = mapped;
      const canRetry = mapped.retryable && attempt < maxAttempts;
      console.warn(
        `[chelcoach-api] ai attempt=${attempt}/${maxAttempts} code=${mapped.internalCode} retry=${canRetry}`,
      );
      if (!canRetry) throw mapped;
      await sleep(jitter(backoffMs * attempt), options.signal);
    }
  }
  throw last ?? new AiAnalysisError("ANALYSIS_INTERNAL_ERROR", "retry exhausted");
}
