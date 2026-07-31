/**
 * Resilient analysis-status polling controller (Step 7).
 * Server pollAfterMs is authoritative. Backend remains source of truth.
 *
 * Expected request volume:
 * - One active visible tab: ~1 request per clamped pollAfterMs (1–15s).
 * - One hidden tab: 0 automatic polls while hidden (resume refreshes once on visible).
 * - Terminal / confirmation-required job: 0 automatic polls after the load that
 *   observed the terminal or action-required state.
 */

import {
  isAnalysisApiError,
  type AnalysisClientError,
} from "./analysisClientErrors";
import {
  mergeAnalysisJobView,
  shouldPollJob,
  type AnalysisJobView,
} from "./analysisJobView";
import { emitAnalysisTelemetry } from "./analysisClientTelemetry";
import { statusLabel as presentationStatusLabel } from "./analysisStatusPresentation";

/** Narrow API surface used by the poller — avoids hard dependency cycles in Node tests. */
export type AnalysisStatusApi = {
  getAnalysisStatus: (
    applicationRequestId: string,
    signal?: AbortSignal,
  ) => Promise<AnalysisJobView>;
};

export const MIN_CLIENT_POLL_MS = 1000;
export const MAX_CLIENT_POLL_MS = 15_000;
export const MAX_TRANSIENT_RETRIES = 8;
const BACKOFF_SCHEDULE_MS = [1000, 2000, 4000, 8000, 15_000] as const;

export type Clock = { now: () => number };
export type SchedulerHandle = { clear: () => void };
export type Scheduler = (fn: () => void, ms: number) => SchedulerHandle;
export type VisibilitySource = {
  isHidden: () => boolean;
  subscribe: (listener: () => void) => () => void;
};
export type ConnectivitySource = {
  isOnline: () => boolean;
  subscribe: (listener: () => void) => () => void;
};

export type AnalysisPollerDependencies = {
  clock: Clock;
  schedule: Scheduler;
  visibility: VisibilitySource;
  connectivity: ConnectivitySource;
  api: AnalysisStatusApi;
};

export interface AnalysisPollingController {
  start(): void;
  stop(): void;
  refreshNow(): Promise<void>;
  dispose(): void;
}

export type AnalysisPollingControllerOptions = {
  applicationRequestId: string;
  deps?: Partial<AnalysisPollerDependencies>;
  onJob: (job: AnalysisJobView) => void;
  onClientError?: (error: AnalysisClientError) => void;
  onClearClientError?: () => void;
  /** Random source for jitter (0–1). Inject for tests. */
  random?: () => number;
};

/** @deprecated Snapshot shape retained for Step 5 server test compatibility. */
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

export function clampPollAfterMs(
  ms: number | null | undefined,
  min = MIN_CLIENT_POLL_MS,
  max = MAX_CLIENT_POLL_MS,
): number | null {
  if (ms === null || ms === undefined) return null;
  if (!Number.isFinite(ms)) return MIN_CLIENT_POLL_MS;
  return Math.min(max, Math.max(min, Math.floor(ms)));
}

export function shouldStopPolling(
  status: Pick<AnalysisStatusSnapshot, "terminal" | "userActionRequired" | "status" | "pollAfterMs">,
): boolean {
  return (
    status.terminal ||
    status.userActionRequired ||
    status.status === "awaiting_player_confirmation" ||
    status.pollAfterMs === null
  );
}

export const ANALYSIS_STATUS_LABELS: Record<string, string> = {
  queued: "Queued",
  inspecting_input: "Inspecting gameplay",
  extracting_frames: "Preparing gameplay moments",
  identifying_controlled_player: "Tracking your player",
  awaiting_player_confirmation: "Player confirmation needed",
  validating_player_identity: "Validating player tracking",
  analyzing_gameplay: "Analyzing gameplay",
  validating_report: "Validating coaching report",
  finalizing: "Finalizing report",
  completed: "Complete",
  failed: "Analysis failed",
  cancelled: "Cancelled",
};

export function statusLabel(status: string): string {
  return ANALYSIS_STATUS_LABELS[status] ?? presentationStatusLabel(status);
}

function defaultSchedule(fn: () => void, ms: number): SchedulerHandle {
  const id = setTimeout(fn, ms);
  return { clear: () => clearTimeout(id) };
}

function defaultVisibility(): VisibilitySource {
  return {
    isHidden: () =>
      typeof document !== "undefined" ? document.visibilityState === "hidden" : false,
    subscribe: (listener) => {
      if (typeof document === "undefined") return () => undefined;
      const handler = () => listener();
      document.addEventListener("visibilitychange", handler);
      return () => document.removeEventListener("visibilitychange", handler);
    },
  };
}

function defaultConnectivity(): ConnectivitySource {
  return {
    isOnline: () => (typeof navigator === "undefined" ? true : navigator.onLine !== false),
    subscribe: (listener) => {
      if (typeof window === "undefined") return () => undefined;
      const handler = () => listener();
      window.addEventListener("online", handler);
      window.addEventListener("offline", handler);
      return () => {
        window.removeEventListener("online", handler);
        window.removeEventListener("offline", handler);
      };
    },
  };
}

function resolveDeps(partial?: Partial<AnalysisPollerDependencies>): AnalysisPollerDependencies {
  return {
    clock: partial?.clock ?? { now: () => Date.now() },
    schedule: partial?.schedule ?? defaultSchedule,
    visibility: partial?.visibility ?? defaultVisibility(),
    connectivity: partial?.connectivity ?? defaultConnectivity(),
    api:
      partial?.api ??
      ({
        // Lazy bind so Node unit tests can import clamp/poll helpers without the fetch client.
        getAnalysisStatus: (id, signal) =>
          import("./analysisClient").then((m) => m.getAnalysisStatus(id, signal)),
      } satisfies AnalysisStatusApi),
  };
}

function backoffDelayMs(attempt: number, random: () => number): number {
  const base =
    BACKOFF_SCHEDULE_MS[Math.min(attempt - 1, BACKOFF_SCHEDULE_MS.length - 1)] ??
    MAX_CLIENT_POLL_MS;
  const jitter = Math.floor(random() * 250);
  return Math.min(MAX_CLIENT_POLL_MS, base + jitter);
}

export function createAnalysisPollingController(
  opts: AnalysisPollingControllerOptions,
): AnalysisPollingController {
  const deps = resolveDeps(opts.deps);
  const random = opts.random ?? Math.random;

  let disposed = false;
  let running = false;
  let inFlight = false;
  let requestGeneration = 0;
  let highestSequence = 0;
  let currentJob: AnalysisJobView | null = null;
  let transientFailures = 0;
  let timer: SchedulerHandle | null = null;
  let controller: AbortController | null = null;
  let unsubVisibility: (() => void) | null = null;
  let unsubConnectivity: (() => void) | null = null;

  const clearTimer = () => {
    timer?.clear();
    timer = null;
  };

  const scheduleNext = (ms: number) => {
    clearTimer();
    if (disposed || !running) return;
    timer = deps.schedule(() => {
      void tick();
    }, ms);
  };

  const applyJob = (incoming: AnalysisJobView, generation: number): boolean => {
    if (disposed || generation !== requestGeneration) {
      emitAnalysisTelemetry("stale_response_ignored", {
        applicationRequestId: opts.applicationRequestId,
        reason: "stale_generation",
        statusSequence: incoming.statusSequence,
      });
      return false;
    }
    const merged = mergeAnalysisJobView(currentJob, incoming);
    if (!merged.accepted) {
      emitAnalysisTelemetry("stale_response_ignored", {
        applicationRequestId: opts.applicationRequestId,
        reason: "lower_sequence",
        statusSequence: incoming.statusSequence,
      });
      return false;
    }
    const advanced =
      !currentJob || incoming.statusSequence > (currentJob?.statusSequence ?? 0);
    currentJob = merged.next;
    if (incoming.statusSequence > highestSequence) {
      highestSequence = incoming.statusSequence;
    }
    opts.onJob(currentJob);
    if (advanced && merged.reason === "higher") {
      emitAnalysisTelemetry("status_advanced", {
        applicationRequestId: opts.applicationRequestId,
        status: currentJob.status,
        statusSequence: currentJob.statusSequence,
      });
      if (currentJob.userActionRequired || currentJob.status === "awaiting_player_confirmation") {
        emitAnalysisTelemetry("confirmation_required", {
          applicationRequestId: opts.applicationRequestId,
          statusSequence: currentJob.statusSequence,
        });
      }
      if (currentJob.reportAvailable) {
        emitAnalysisTelemetry("report_available", {
          applicationRequestId: opts.applicationRequestId,
          statusSequence: currentJob.statusSequence,
        });
      }
    }
    return true;
  };

  const tick = async (optsTick?: { force?: boolean }) => {
    if (disposed || !running) return;
    if (inFlight) return;
    if (!optsTick?.force) {
      if (deps.visibility.isHidden()) return;
      if (!deps.connectivity.isOnline()) return;
    } else {
      // Forced refresh still skips when offline (unless explicitly online).
      if (!deps.connectivity.isOnline()) {
        opts.onClientError?.({
          type: "offline",
          retryable: true,
          message: "You appear to be offline. Your analysis is still saved.",
        });
        return;
      }
    }

    inFlight = true;
    const generation = ++requestGeneration;
    controller?.abort();
    controller = new AbortController();
    try {
      const job = await deps.api.getAnalysisStatus(
        opts.applicationRequestId,
        controller.signal,
      );
      if (disposed || generation !== requestGeneration) return;
      transientFailures = 0;
      opts.onClearClientError?.();
      const applied = applyJob(job, generation);
      if (!applied) return;
      if (!shouldPollJob(job) || shouldStopPolling(job)) {
        clearTimer();
        emitAnalysisTelemetry("polling_stopped", {
          applicationRequestId: opts.applicationRequestId,
          reason: job.terminal
            ? "terminal"
            : job.userActionRequired
              ? "confirmation"
              : "null_poll",
          status: job.status,
        });
        return;
      }
      if (deps.visibility.isHidden() || !deps.connectivity.isOnline()) {
        clearTimer();
        return;
      }
      const delay = clampPollAfterMs(job.pollAfterMs);
      if (delay === null) {
        clearTimer();
        return;
      }
      scheduleNext(delay);
    } catch (err) {
      if (disposed || generation !== requestGeneration) return;
      if (err instanceof DOMException && err.name === "AbortError") return;
      if (err instanceof Error && err.name === "AbortError") return;

      const clientError: AnalysisClientError = isAnalysisApiError(err)
        ? err.clientError
        : {
            type: "network",
            retryable: true,
            message: "Connection interrupted. Your analysis is still saved.",
          };

      // Auth / forbidden — stop polling; preserve last durable state.
      if (
        clientError.type === "session_expired" ||
        clientError.type === "forbidden" ||
        clientError.type === "not_found" ||
        clientError.type === "malformed_id"
      ) {
        opts.onClientError?.(clientError);
        clearTimer();
        emitAnalysisTelemetry("polling_stopped", {
          applicationRequestId: opts.applicationRequestId,
          reason: clientError.type,
        });
        return;
      }

      // Transient — keep last job; do not mark failed locally.
      opts.onClientError?.(clientError);
      transientFailures += 1;
      if (transientFailures > MAX_TRANSIENT_RETRIES) {
        clearTimer();
        emitAnalysisTelemetry("polling_stopped", {
          applicationRequestId: opts.applicationRequestId,
          reason: "max_retries",
          attempt: transientFailures,
        });
        return;
      }
      if (deps.visibility.isHidden() || !deps.connectivity.isOnline()) {
        clearTimer();
        return;
      }
      const delay = backoffDelayMs(transientFailures, random);
      emitAnalysisTelemetry("network_retry_scheduled", {
        applicationRequestId: opts.applicationRequestId,
        attempt: transientFailures,
        delayMs: delay,
      });
      scheduleNext(delay);
    } finally {
      inFlight = false;
    }
  };

  const onVisibility = () => {
    if (disposed || !running) return;
    if (deps.visibility.isHidden()) {
      emitAnalysisTelemetry("visibility_pause", {
        applicationRequestId: opts.applicationRequestId,
      });
      clearTimer();
      // Allow in-flight to finish; do not abort aggressively (safe finish).
      return;
    }
    void tick({ force: true });
  };

  const onConnectivity = () => {
    if (disposed || !running) return;
    if (!deps.connectivity.isOnline()) {
      emitAnalysisTelemetry("connectivity_pause", {
        applicationRequestId: opts.applicationRequestId,
      });
      clearTimer();
      opts.onClientError?.({
        type: "offline",
        retryable: true,
        message: "You appear to be offline. Your analysis is still saved.",
      });
      return;
    }
    void tick({ force: true });
  };

  return {
    start() {
      if (disposed || running) return;
      running = true;
      emitAnalysisTelemetry("polling_started", {
        applicationRequestId: opts.applicationRequestId,
      });
      unsubVisibility = deps.visibility.subscribe(onVisibility);
      unsubConnectivity = deps.connectivity.subscribe(onConnectivity);
      void tick({ force: true });
    },
    stop() {
      running = false;
      clearTimer();
      controller?.abort();
      controller = null;
      emitAnalysisTelemetry("polling_stopped", {
        applicationRequestId: opts.applicationRequestId,
        reason: "stop",
      });
    },
    async refreshNow() {
      if (disposed) return;
      if (!running) {
        running = true;
        unsubVisibility = deps.visibility.subscribe(onVisibility);
        unsubConnectivity = deps.connectivity.subscribe(onConnectivity);
      }
      await tick({ force: true });
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      running = false;
      clearTimer();
      controller?.abort();
      controller = null;
      unsubVisibility?.();
      unsubConnectivity?.();
      unsubVisibility = null;
      unsubConnectivity = null;
      emitAnalysisTelemetry("polling_stopped", {
        applicationRequestId: opts.applicationRequestId,
        reason: "dispose",
      });
    },
  };
}

/**
 * Compatibility wrapper for Step 5 server tests.
 * Prefer `createAnalysisPollingController` in new code.
 */
export interface AnalysisStatusPollerOptions {
  fetchStatus: (signal: AbortSignal) => Promise<AnalysisStatusSnapshot>;
  clampPollMs?: (ms: number | null) => number | null;
  maxTransientRetries?: number;
  onStatus: (status: AnalysisStatusSnapshot) => void;
  onError?: (error: Error, attempt: number) => void;
  schedule?: (fn: () => void, ms: number) => { clear: () => void };
  now?: () => number;
}

export function startAnalysisStatusPoller(opts: AnalysisStatusPollerOptions): {
  stop: () => void;
} {
  const clamp = opts.clampPollMs ?? clampPollAfterMs;
  const maxRetries = opts.maxTransientRetries ?? 3;
  const schedule = opts.schedule ?? defaultSchedule;

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
      const delay = clamp(status.pollAfterMs) ?? MIN_CLIENT_POLL_MS;
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
      }, MIN_CLIENT_POLL_MS);
    } finally {
      inFlight = false;
    }
  };

  void tick();
  return { stop };
}
