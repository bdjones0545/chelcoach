import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clampPollAfterMs,
  createAnalysisPollingController,
  MAX_CLIENT_POLL_MS,
  MIN_CLIENT_POLL_MS,
  shouldStopPolling,
  startAnalysisStatusPoller,
} from "./analysisStatusPoller";
import { makeJob } from "../test/analysisJobFixtures";
import type { AnalysisJobView } from "./analysisJobView";
import { AnalysisApiError } from "./analysisClientErrors";

function createHarness() {
  const timers: Array<{ fn: () => void; ms: number; cleared: boolean }> = [];
  const visibilityListeners = new Set<() => void>();
  const connectivityListeners = new Set<() => void>();
  let hidden = false;
  let online = true;

  return {
    timers,
    setHidden(next: boolean) {
      hidden = next;
      for (const l of visibilityListeners) l();
    },
    setOnline(next: boolean) {
      online = next;
      for (const l of connectivityListeners) l();
    },
    deps: {
      clock: { now: () => 0 },
      schedule: (fn: () => void, ms: number) => {
        const entry = { fn, ms, cleared: false };
        timers.push(entry);
        return {
          clear: () => {
            entry.cleared = true;
          },
        };
      },
      visibility: {
        isHidden: () => hidden,
        subscribe: (listener: () => void) => {
          visibilityListeners.add(listener);
          return () => visibilityListeners.delete(listener);
        },
      },
      connectivity: {
        isOnline: () => online,
        subscribe: (listener: () => void) => {
          connectivityListeners.add(listener);
          return () => connectivityListeners.delete(listener);
        },
      },
    },
    async flush() {
      await Promise.resolve();
      await Promise.resolve();
    },
    runNextTimer() {
      const next = timers.find((t) => !t.cleared);
      if (!next) return false;
      next.cleared = true;
      next.fn();
      return true;
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("clampPollAfterMs", () => {
  it("returns null for null (stops polling)", () => {
    expect(clampPollAfterMs(null)).toBeNull();
  });
  it("enforces minimum poll bound", () => {
    expect(clampPollAfterMs(50)).toBe(MIN_CLIENT_POLL_MS);
  });
  it("enforces maximum poll bound", () => {
    expect(clampPollAfterMs(99_999)).toBe(MAX_CLIENT_POLL_MS);
  });
  it("respects values inside bounds", () => {
    expect(clampPollAfterMs(2500)).toBe(2500);
  });
});

describe("shouldStopPolling", () => {
  it("stops for terminal, confirmation, and null poll", () => {
    expect(
      shouldStopPolling({
        status: "completed",
        terminal: true,
        userActionRequired: false,
        pollAfterMs: null,
      }),
    ).toBe(true);
    expect(
      shouldStopPolling({
        status: "awaiting_player_confirmation",
        terminal: false,
        userActionRequired: true,
        pollAfterMs: null,
      }),
    ).toBe(true);
    expect(
      shouldStopPolling({
        status: "analyzing_gameplay",
        terminal: false,
        userActionRequired: false,
        pollAfterMs: null,
      }),
    ).toBe(true);
  });
});

describe("createAnalysisPollingController", () => {
  it("respects server pollAfterMs and does not overlap requests", async () => {
    const h = createHarness();
    let inFlight = 0;
    let overlap = 0;
    let calls = 0;
    const jobs = [
      makeJob({ status: "queued", statusLabel: "Queued", sequenceNumber: 1, pollAfterMs: 2000 }),
      makeJob({
        status: "analyzing_gameplay",
        statusLabel: "Analyzing gameplay",
        sequenceNumber: 2,
        pollAfterMs: 3000,
      }),
      makeJob({
        status: "completed",
        statusLabel: "Complete",
        sequenceNumber: 3,
        pollAfterMs: null,
        terminal: true,
        reportReady: true,
        reportAvailable: true,
        cancellationAvailable: false,
      }),
    ];
    const seen: AnalysisJobView[] = [];
    const controller = createAnalysisPollingController({
      applicationRequestId: jobs[0]!.applicationRequestId,
      random: () => 0,
      deps: {
        ...h.deps,
        api: {
          getAnalysisStatus: async () => {
            inFlight += 1;
            if (inFlight > 1) overlap += 1;
            const job = jobs[Math.min(calls, jobs.length - 1)]!;
            calls += 1;
            inFlight -= 1;
            return job;
          },
        },
      },
      onJob: (j) => seen.push(j),
    });
    controller.start();
    await h.flush();
    expect(calls).toBe(1);
    expect(h.timers.some((t) => !t.cleared && t.ms === 2000)).toBe(true);
    h.runNextTimer();
    await h.flush();
    expect(calls).toBe(2);
    h.runNextTimer();
    await h.flush();
    expect(calls).toBe(3);
    expect(h.timers.every((t) => t.cleared || t.ms === 0)).toBe(true);
    expect(overlap).toBe(0);
    expect(seen.at(-1)?.status).toBe("completed");
    // Terminal job request volume zero after load — no further timers.
    const uncleared = h.timers.filter((t) => !t.cleared);
    expect(uncleared.length).toBe(0);
    controller.dispose();
  });

  it("does not poll confirmation-required jobs continuously", async () => {
    const h = createHarness();
    let calls = 0;
    const controller = createAnalysisPollingController({
      applicationRequestId: "req-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      deps: {
        ...h.deps,
        api: {
          getAnalysisStatus: async () => {
            calls += 1;
            return makeJob({
              status: "awaiting_player_confirmation",
              statusLabel: "Player confirmation needed",
              userActionRequired: true,
              pollAfterMs: null,
              cancellationAvailable: false,
            });
          },
        },
      },
      onJob: () => undefined,
    });
    controller.start();
    await h.flush();
    expect(calls).toBe(1);
    expect(h.timers.filter((t) => !t.cleared).length).toBe(0);
    controller.dispose();
  });

  it("ignores lower sequence and stale generation responses", async () => {
    const h = createHarness();
    const seen: AnalysisJobView[] = [];
    let resolveSlow: ((job: AnalysisJobView) => void) | null = null;
    let call = 0;
    const controller = createAnalysisPollingController({
      applicationRequestId: "req-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      random: () => 0,
      deps: {
        ...h.deps,
        api: {
          getAnalysisStatus: async () => {
            call += 1;
            if (call === 1) {
              return makeJob({ sequenceNumber: 5, status: "analyzing_gameplay", pollAfterMs: 1000 });
            }
            if (call === 2) {
              return new Promise<AnalysisJobView>((resolve) => {
                resolveSlow = resolve;
              });
            }
            return makeJob({
              sequenceNumber: 6,
              status: "finalizing",
              statusLabel: "Finalizing report",
              pollAfterMs: 1000,
            });
          },
        },
      },
      onJob: (j) => seen.push(j),
    });
    controller.start();
    await h.flush();
    expect(seen.at(-1)?.statusSequence).toBe(5);
    // Start a forced refresh that will finish first with higher sequence.
    const refreshPromise = controller.refreshNow();
    await h.flush();
    // Resolve stale lower-sequence response after newer one.
    resolveSlow?.(
      makeJob({
        sequenceNumber: 4,
        status: "queued",
        statusLabel: "Queued",
        pollAfterMs: 1000,
      }),
    );
    await refreshPromise;
    await h.flush();
    expect(seen.at(-1)?.statusSequence).toBeGreaterThanOrEqual(5);
    expect(seen.some((j) => j.statusSequence === 4 && j === seen.at(-1))).toBe(false);
    controller.dispose();
  });

  it("equal sequence updates safe metadata without regressing lifecycle", async () => {
    const h = createHarness();
    const seen: AnalysisJobView[] = [];
    let call = 0;
    const controller = createAnalysisPollingController({
      applicationRequestId: "req-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      random: () => 0,
      deps: {
        ...h.deps,
        api: {
          getAnalysisStatus: async () => {
            call += 1;
            if (call === 1) {
              return makeJob({
                sequenceNumber: 3,
                degraded: false,
                pollAfterMs: 2000,
                updatedAt: "2026-07-31T12:00:00.000Z",
              });
            }
            return makeJob({
              sequenceNumber: 3,
              degraded: true,
              pollAfterMs: 5000,
              updatedAt: "2026-07-31T12:00:10.000Z",
              message: "Delayed sync",
            });
          },
        },
      },
      onJob: (j) => seen.push(j),
    });
    controller.start();
    await h.flush();
    h.runNextTimer();
    await h.flush();
    const last = seen.at(-1)!;
    expect(last.statusSequence).toBe(3);
    expect(last.degraded).toBe(true);
    expect(last.pollAfterMs).toBe(5000);
    expect(last.status).toBe("analyzing_gameplay");
    controller.dispose();
  });

  it("pauses when hidden and refreshes immediately when visible", async () => {
    const h = createHarness();
    let calls = 0;
    const controller = createAnalysisPollingController({
      applicationRequestId: "req-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      random: () => 0,
      deps: {
        ...h.deps,
        api: {
          getAnalysisStatus: async () => {
            calls += 1;
            return makeJob({ sequenceNumber: calls, pollAfterMs: 2000 });
          },
        },
      },
      onJob: () => undefined,
    });
    controller.start();
    await h.flush();
    expect(calls).toBe(1);
    h.setHidden(true);
    await h.flush();
    // Hidden tab — no aggressive polling; uncleared timers cleared.
    expect(h.timers.filter((t) => !t.cleared).length).toBe(0);
    const callsWhileHidden = calls;
    h.setHidden(false);
    await h.flush();
    expect(calls).toBe(callsWhileHidden + 1);
    controller.dispose();
  });

  it("pauses offline, preserves last state, resumes on online", async () => {
    const h = createHarness();
    const seen: AnalysisJobView[] = [];
    const errors: string[] = [];
    let calls = 0;
    const controller = createAnalysisPollingController({
      applicationRequestId: "req-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      random: () => 0,
      deps: {
        ...h.deps,
        api: {
          getAnalysisStatus: async () => {
            calls += 1;
            return makeJob({ sequenceNumber: calls, pollAfterMs: 2000 });
          },
        },
      },
      onJob: (j) => seen.push(j),
      onClientError: (e) => errors.push(e.type),
    });
    controller.start();
    await h.flush();
    const lastStatus = seen.at(-1)!.status;
    h.setOnline(false);
    await h.flush();
    expect(errors).toContain("offline");
    expect(seen.at(-1)!.status).toBe(lastStatus);
    expect(seen.at(-1)!.status).not.toBe("failed");
    const before = calls;
    h.setOnline(true);
    await h.flush();
    expect(calls).toBe(before + 1);
    controller.dispose();
  });

  it("uses capped exponential backoff on transient failures and resets after success", async () => {
    const h = createHarness();
    let calls = 0;
    const controller = createAnalysisPollingController({
      applicationRequestId: "req-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      random: () => 0,
      deps: {
        ...h.deps,
        api: {
          getAnalysisStatus: async () => {
            calls += 1;
            if (calls <= 3) {
              throw new AnalysisApiError({
                type: "network",
                retryable: true,
                message: "Connection interrupted. Your analysis is still saved.",
              });
            }
            return makeJob({ sequenceNumber: 1, pollAfterMs: 2000 });
          },
        },
      },
      onJob: () => undefined,
    });
    controller.start();
    await h.flush();
    expect(h.timers.some((t) => !t.cleared && t.ms === 1000)).toBe(true);
    h.runNextTimer();
    await h.flush();
    expect(h.timers.some((t) => !t.cleared && t.ms === 2000)).toBe(true);
    h.runNextTimer();
    await h.flush();
    expect(h.timers.some((t) => !t.cleared && t.ms === 4000)).toBe(true);
    h.runNextTimer();
    await h.flush();
    // Success schedules server poll delay, not backoff.
    expect(h.timers.some((t) => !t.cleared && t.ms === 2000)).toBe(true);
    controller.dispose();
  });

  it("stops polling on session expiration", async () => {
    const h = createHarness();
    const errors: string[] = [];
    const controller = createAnalysisPollingController({
      applicationRequestId: "req-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      deps: {
        ...h.deps,
        api: {
          getAnalysisStatus: async () => {
            throw new AnalysisApiError({
              type: "session_expired",
              retryable: false,
              message: "Your session expired. Sign in again to continue this analysis.",
            });
          },
        },
      },
      onJob: () => undefined,
      onClientError: (e) => errors.push(e.type),
    });
    controller.start();
    await h.flush();
    expect(errors).toContain("session_expired");
    expect(h.timers.filter((t) => !t.cleared).length).toBe(0);
    controller.dispose();
  });

  it("aborts in-flight request on dispose", async () => {
    const h = createHarness();
    let aborted = false;
    const controller = createAnalysisPollingController({
      applicationRequestId: "req-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      deps: {
        ...h.deps,
        api: {
          getAnalysisStatus: async (_id, signal) => {
            await new Promise<void>((resolve) => {
              signal?.addEventListener("abort", () => {
                aborted = true;
                resolve();
              });
            });
            throw new DOMException("Aborted", "AbortError");
          },
        },
      },
      onJob: () => undefined,
    });
    controller.start();
    await h.flush();
    controller.dispose();
    await h.flush();
    expect(aborted).toBe(true);
  });

  it("compatibility startAnalysisStatusPoller still works for server tests", async () => {
    let calls = 0;
    const scheduled: Array<() => void> = [];
    const poller = startAnalysisStatusPoller({
      fetchStatus: async () => {
        calls += 1;
        return {
          status: calls >= 2 ? "completed" : "queued",
          terminal: calls >= 2,
          userActionRequired: false,
          pollAfterMs: calls >= 2 ? null : 1000,
          reportReady: calls >= 2,
        };
      },
      schedule: (fn) => {
        scheduled.push(fn);
        return { clear: () => undefined };
      },
      onStatus: () => undefined,
    });
    await Promise.resolve();
    expect(calls).toBe(1);
    scheduled.shift()?.();
    await Promise.resolve();
    expect(calls).toBe(2);
    poller.stop();
  });
});
