/**
 * Reusable analysis-status polling.
 *
 * Sequential (no overlapping requests): fetch → decide → wait → repeat.
 * Stops on completed / failed / timeout / abort / invalid payload.
 * Network errors are retried until the overall timeout; they do not look like
 * job failures.
 *
 * MVP timing (chosen for future ffmpeg/AI without hammering the API):
 *   interval: 2s
 *   timeout:  5 minutes
 */
import type { AnalysisJobStatus } from "../../shared/analysisContract";
import { InvalidAnalysisJobStatusError } from "./analysisJobStatus";

export const POLL_INTERVAL_MS = 2_000;
export const POLL_TIMEOUT_MS = 5 * 60 * 1_000;

export type PollOutcome =
  | { outcome: "completed"; status: AnalysisJobStatus }
  | { outcome: "failed"; status: AnalysisJobStatus }
  | { outcome: "timeout" }
  | { outcome: "aborted" }
  | { outcome: "invalid"; error: Error }
  | { outcome: "unreachable"; error: Error };

export interface PollAnalysisStatusOptions {
  /** Fetches the latest status. Must throw on transport failure. */
  fetchStatus: () => Promise<AnalysisJobStatus>;
  intervalMs?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Optional clock for tests. */
  now?: () => number;
  /** Optional sleeper for tests. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const id = setTimeout(resolve, ms);
    const onAbort = () => {
      clearTimeout(id);
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function isAbortError(err: unknown): boolean {
  return (
    (err instanceof DOMException && err.name === "AbortError") ||
    (err instanceof Error && err.name === "AbortError")
  );
}

/**
 * Poll until the analysis job reaches a terminal state, the timeout elapses,
 * the payload is invalid, or the caller aborts.
 */
export async function pollAnalysisStatus(options: PollAnalysisStatusOptions): Promise<PollOutcome> {
  const intervalMs = options.intervalMs ?? POLL_INTERVAL_MS;
  const timeoutMs = options.timeoutMs ?? POLL_TIMEOUT_MS;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const signal = options.signal;
  const started = now();

  let inFlight = false;
  let lastNetworkError: Error | null = null;

  while (true) {
    if (signal?.aborted) return { outcome: "aborted" };
    if (now() - started >= timeoutMs) {
      return lastNetworkError
        ? { outcome: "unreachable", error: lastNetworkError }
        : { outcome: "timeout" };
    }

    if (inFlight) {
      // Defensive: sequential loop should never overlap; surface as unreachable.
      return { outcome: "unreachable", error: new Error("Overlapping status request.") };
    }

    inFlight = true;
    try {
      const status = await options.fetchStatus();
      lastNetworkError = null;

      if (status.status === "completed") return { outcome: "completed", status };
      if (status.status === "failed") return { outcome: "failed", status };
      // queued | processing → keep polling
    } catch (err) {
      if (isAbortError(err)) return { outcome: "aborted" };
      if (err instanceof InvalidAnalysisJobStatusError) {
        return { outcome: "invalid", error: err };
      }
      lastNetworkError = err instanceof Error ? err : new Error(String(err));
      // Transient network — retry until timeout.
    } finally {
      inFlight = false;
    }

    if (signal?.aborted) return { outcome: "aborted" };
    if (now() - started >= timeoutMs) {
      return lastNetworkError
        ? { outcome: "unreachable", error: lastNetworkError }
        : { outcome: "timeout" };
    }

    try {
      await sleep(intervalMs, signal);
    } catch (err) {
      if (isAbortError(err)) return { outcome: "aborted" };
      throw err;
    }
  }
}
