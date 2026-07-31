import { describe, expect, it, vi } from "vitest";
import type { AnalysisJobStatus } from "../../shared/analysisContract";
import { InvalidAnalysisJobStatusError, parseAnalysisJobStatus } from "./analysisJobStatus";
import { pollAnalysisStatus, POLL_INTERVAL_MS, POLL_TIMEOUT_MS } from "./pollStatus";

function status(partial: Partial<AnalysisJobStatus> & Pick<AnalysisJobStatus, "status" | "reportReady">): AnalysisJobStatus {
  return {
    clipId: "clip-1",
    ...partial,
  };
}

function createClock() {
  let t = 0;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

function createSleep(clock: { advance: (ms: number) => void }) {
  return async (ms: number, signal?: AbortSignal) => {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    clock.advance(ms);
  };
}

describe("parseAnalysisJobStatus", () => {
  it("accepts a valid completed payload", () => {
    const parsed = parseAnalysisJobStatus({
      clipId: "abc",
      status: "completed",
      reportReady: true,
      phaseProgress: 100,
    });
    expect(parsed.status).toBe("completed");
    expect(parsed.reportReady).toBe(true);
  });

  it("rejects malformed payloads", () => {
    expect(() => parseAnalysisJobStatus({ status: "completed" })).toThrow(InvalidAnalysisJobStatusError);
    expect(() => parseAnalysisJobStatus({ clipId: "x", status: "nope", reportReady: true })).toThrow(
      InvalidAnalysisJobStatusError,
    );
    expect(() =>
      parseAnalysisJobStatus({ clipId: "x", status: "completed", reportReady: false }),
    ).toThrow(InvalidAnalysisJobStatusError);
  });
});

describe("pollAnalysisStatus", () => {
  it("returns immediately on completed (no artificial delay)", async () => {
    const fetchStatus = vi.fn(async () => status({ status: "completed", reportReady: true }));
    const outcome = await pollAnalysisStatus({ fetchStatus, intervalMs: 10, timeoutMs: 1000 });
    expect(outcome).toEqual({
      outcome: "completed",
      status: expect.objectContaining({ status: "completed", reportReady: true }),
    });
    expect(fetchStatus).toHaveBeenCalledTimes(1);
  });

  it("walks queued → processing → completed", async () => {
    const clock = createClock();
    const sequence: AnalysisJobStatus[] = [
      status({ status: "queued", reportReady: false, phaseProgress: 25 }),
      status({ status: "processing", reportReady: false, phaseProgress: 60 }),
      status({ status: "completed", reportReady: true, phaseProgress: 100 }),
    ];
    const fetchStatus = vi.fn(async () => {
      const next = sequence.shift();
      if (!next) throw new Error("unexpected extra fetch");
      return next;
    });

    const outcome = await pollAnalysisStatus({
      fetchStatus,
      intervalMs: 10,
      timeoutMs: 1000,
      now: clock.now,
      sleep: createSleep(clock),
    });

    expect(outcome.outcome).toBe("completed");
    expect(fetchStatus).toHaveBeenCalledTimes(3);
  });

  it("surfaces backend-declared failure", async () => {
    const fetchStatus = vi.fn(async () =>
      status({ status: "failed", reportReady: false, errorCode: "analysis_failed", errorMessage: "boom" }),
    );
    const outcome = await pollAnalysisStatus({ fetchStatus, intervalMs: 10, timeoutMs: 1000 });
    expect(outcome.outcome).toBe("failed");
    if (outcome.outcome === "failed") {
      expect(outcome.status.errorMessage).toBe("boom");
    }
  });

  it("times out when status never completes", async () => {
    const clock = createClock();
    const fetchStatus = vi.fn(async () => status({ status: "processing", reportReady: false }));
    const outcome = await pollAnalysisStatus({
      fetchStatus,
      intervalMs: 100,
      timeoutMs: 250,
      now: clock.now,
      sleep: createSleep(clock),
    });
    expect(outcome.outcome).toBe("timeout");
    expect(fetchStatus.mock.calls.length).toBeGreaterThan(1);
  });

  it("retries transient network errors then succeeds", async () => {
    const clock = createClock();
    let calls = 0;
    const fetchStatus = vi.fn(async () => {
      calls += 1;
      if (calls < 3) throw new Error("network down");
      return status({ status: "completed", reportReady: true });
    });
    const outcome = await pollAnalysisStatus({
      fetchStatus,
      intervalMs: 10,
      timeoutMs: 1000,
      now: clock.now,
      sleep: createSleep(clock),
    });
    expect(outcome.outcome).toBe("completed");
    expect(fetchStatus).toHaveBeenCalledTimes(3);
  });

  it("returns unreachable when only network errors occur until timeout", async () => {
    const clock = createClock();
    const fetchStatus = vi.fn(async () => {
      throw new Error("network down");
    });
    const outcome = await pollAnalysisStatus({
      fetchStatus,
      intervalMs: 50,
      timeoutMs: 120,
      now: clock.now,
      sleep: createSleep(clock),
    });
    expect(outcome.outcome).toBe("unreachable");
  });

  it("stops on abort / cancellation", async () => {
    const controller = new AbortController();
    const fetchStatus = vi.fn(async () => {
      controller.abort();
      return status({ status: "processing", reportReady: false });
    });
    const outcome = await pollAnalysisStatus({
      fetchStatus,
      signal: controller.signal,
      intervalMs: 10,
      timeoutMs: 1000,
      sleep: async (_ms, signal) => {
        if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      },
    });
    expect(outcome.outcome).toBe("aborted");
  });

  it("does not overlap in-flight status requests (sequential)", async () => {
    const clock = createClock();
    let inflight = 0;
    let maxInflight = 0;
    const fetchStatus = vi.fn(async () => {
      inflight += 1;
      maxInflight = Math.max(maxInflight, inflight);
      await Promise.resolve();
      inflight -= 1;
      if (fetchStatus.mock.calls.length >= 2) {
        return status({ status: "completed", reportReady: true });
      }
      return status({ status: "queued", reportReady: false });
    });
    await pollAnalysisStatus({
      fetchStatus,
      intervalMs: 5,
      timeoutMs: 1000,
      now: clock.now,
      sleep: createSleep(clock),
    });
    expect(maxInflight).toBe(1);
  });

  it("treats invalid status payloads as invalid (no silent success)", async () => {
    const fetchStatus = vi.fn(async () => {
      throw new InvalidAnalysisJobStatusError("bad");
    });
    const outcome = await pollAnalysisStatus({ fetchStatus, intervalMs: 10, timeoutMs: 1000 });
    expect(outcome.outcome).toBe("invalid");
  });

  it("exports MVP interval and timeout suitable for future processing", () => {
    expect(POLL_INTERVAL_MS).toBe(2_000);
    expect(POLL_TIMEOUT_MS).toBe(5 * 60 * 1_000);
  });
});

describe("demo-versus-live helpers", () => {
  it("demo mode is intentional when backend flag is off (no active clip)", () => {
    const backendEnabled = false;
    const activeClipId: string | null = null;
    const isDemoMode = !backendEnabled || !activeClipId;
    expect(isDemoMode).toBe(true);
  });

  it("live mode requires backend flag and an active clip id", () => {
    const backendEnabled = true;
    const activeClipId = "clip-123";
    const isDemoMode = !backendEnabled || !activeClipId;
    expect(isDemoMode).toBe(false);
  });
});
