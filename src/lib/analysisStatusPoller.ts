/**
 * Minimal analysis-status poller (Step 5).
 * Full resilient polling / reload recovery is Step 7.
 */

export interface AnalysisStatusSnapshot {
  status: string;
  terminal: boolean;
  userActionRequired: boolean;
  pollAfterMs: number | null;
  reportReady: boolean;
  message?: string;
  errorCode?: string;
  errorMessage?: string;
  sequenceNumber?: number;
  simulatorMode?: boolean;
}

export interface AnalysisStatusPollerOptions {
  fetchStatus: (signal: AbortSignal) => Promise<AnalysisStatusSnapshot>;
  /** Bound advisory poll delay. */
  clampPollMs?: (ms: number | null) => number | null;
  maxTransientRetries?: number;
  onStatus: (status: AnalysisStatusSnapshot) => void;
  onError?: (error: Error, attempt: number) => void;
  /** Injected scheduler for tests. */
  schedule?: (fn: () => void, ms: number) => { clear: () => void };
  now?: () => number;
}

const DEFAULT_MIN_POLL = 200;
const DEFAULT_MAX_POLL = 10_000;
const DEFAULT_FALLBACK_POLL = 1_500;

export function clampPollAfterMs(
  ms: number | null | undefined,
  min = DEFAULT_MIN_POLL,
  max = DEFAULT_MAX_POLL,
): number | null {
  if (ms === null || ms === undefined) return null;
  if (!Number.isFinite(ms)) return DEFAULT_FALLBACK_POLL;
  return Math.min(max, Math.max(min, Math.floor(ms)));
}

export function shouldStopPolling(status: AnalysisStatusSnapshot): boolean {
  return status.terminal || status.userActionRequired || status.status === "awaiting_player_confirmation";
}

/** Human labels — no fake percentages. */
export const ANALYSIS_STATUS_LABELS: Record<string, string> = {
  queued: "Queued",
  inspecting_input: "Inspecting gameplay",
  extracting_frames: "Preparing frames",
  identifying_controlled_player: "Confirming your player",
  awaiting_player_confirmation: "Confirming your player",
  validating_player_identity: "Confirming your player",
  analyzing_gameplay: "Analyzing gameplay",
  validating_report: "Validating coaching report",
  finalizing: "Finalizing report",
  completed: "Complete",
  failed: "Analysis failed",
  cancelled: "Cancelled",
};

export function statusLabel(status: string): string {
  return ANALYSIS_STATUS_LABELS[status] ?? status;
}

function defaultSchedule(fn: () => void, ms: number): { clear: () => void } {
  const id = setTimeout(fn, ms);
  return { clear: () => clearTimeout(id) };
}

/**
 * Starts polling. Call `stop()` on unmount or after terminal/confirmation.
 * Never overlaps in-flight requests; uses AbortController.
 */
export function startAnalysisStatusPoller(opts: AnalysisStatusPollerOptions): {
  stop: () => void;
} {
  const maxRetries = opts.maxTransientRetries ?? 3;
  const schedule = opts.schedule ?? defaultSchedule;
  const clamp = opts.clampPollMs ?? clampPollAfterMs;

  let stopped = false;
  let inFlight = false;
  let retries = 0;
  let timer: { clear: () => void } | null = null;
  let controller: AbortController | null = null;

  const clearTimer = () => {
    timer?.clear();
    timer = null;
  };

  const stop = () => {
    stopped = true;
    clearTimer();
    controller?.abort();
    controller = null;
  };

  const tick = async () => {
    if (stopped || inFlight) return;
    inFlight = true;
    controller = new AbortController();
    try {
      const status = await opts.fetchStatus(controller.signal);
      if (stopped) return;
      retries = 0;
      opts.onStatus(status);
      if (shouldStopPolling(status)) {
        stop();
        return;
      }
      const delay = clamp(status.pollAfterMs) ?? DEFAULT_FALLBACK_POLL;
      clearTimer();
      timer = schedule(() => {
        void tick();
      }, delay);
    } catch (err) {
      if (stopped) return;
      if (err instanceof DOMException && err.name === "AbortError") return;
      if (err instanceof Error && err.name === "AbortError") return;
      retries += 1;
      opts.onError?.(err instanceof Error ? err : new Error(String(err)), retries);
      if (retries > maxRetries) {
        stop();
        return;
      }
      clearTimer();
      timer = schedule(() => {
        void tick();
      }, DEFAULT_FALLBACK_POLL);
    } finally {
      inFlight = false;
    }
  };

  void tick();
  return { stop };
}
