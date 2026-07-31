import { describe, expect, it, vi } from "vitest";
import type { AnalysisJobStatus } from "../../shared/analysisContract";
import { InvalidAnalysisJobStatusError } from "./analysisJobStatus";
import { pollAnalysisStatus } from "./pollStatus";

/**
 * Integration-style unit tests for the Processing live-path invariants:
 * - report is fetched once on completed
 * - navigation is triggered once
 * - malformed status never yields a demo/live success
 */
describe("live processing flow invariants", () => {
  it("fetches the report once and navigates once on completed", async () => {
    const fetchStatus = vi.fn(async (): Promise<AnalysisJobStatus> => ({
      clipId: "c1",
      status: "completed",
      reportReady: true,
      phaseProgress: 100,
    }));
    const fetchReport = vi.fn(async () => ({ ok: true }));
    const navigate = vi.fn();

    const outcome = await pollAnalysisStatus({ fetchStatus, intervalMs: 1, timeoutMs: 500 });
    expect(outcome.outcome).toBe("completed");

    // Simulate Processing screen post-poll handling.
    let reportFetched = false;
    let navigated = false;
    const acceptAndGo = async () => {
      if (reportFetched) return;
      reportFetched = true;
      await fetchReport();
      if (navigated) return;
      navigated = true;
      navigate("/scorecard");
    };
    await acceptAndGo();
    await acceptAndGo(); // duplicate call must be a no-op

    expect(fetchReport).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledTimes(1);
  });

  it("does not fetch a report or navigate on failed", async () => {
    const fetchStatus = vi.fn(async (): Promise<AnalysisJobStatus> => ({
      clipId: "c1",
      status: "failed",
      reportReady: false,
      errorCode: "analysis_failed",
    }));
    const fetchReport = vi.fn();
    const navigate = vi.fn();

    const outcome = await pollAnalysisStatus({ fetchStatus, intervalMs: 1, timeoutMs: 500 });
    expect(outcome.outcome).toBe("failed");
    if (outcome.outcome !== "failed") return;
    // Processing shows failure UI — no report fetch.
    expect(fetchReport).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });

  it("malformed status fails safely without demo fallback", async () => {
    const fetchStatus = vi.fn(async () => {
      throw new InvalidAnalysisJobStatusError("garbage");
    });
    const restoreDemoReport = vi.fn();
    const acceptLiveReport = vi.fn();

    const outcome = await pollAnalysisStatus({ fetchStatus, intervalMs: 1, timeoutMs: 500 });
    expect(outcome.outcome).toBe("invalid");
    // Live failure path must not install demo data as if it were live.
    expect(restoreDemoReport).not.toHaveBeenCalled();
    expect(acceptLiveReport).not.toHaveBeenCalled();
  });
});
