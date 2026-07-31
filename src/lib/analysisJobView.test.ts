import { describe, expect, it } from "vitest";
import {
  mergeAnalysisJobView,
  parseAnalysisStatusResponse,
  shouldPollJob,
  toAnalysisJobView,
} from "./analysisJobView";
import { makeJob, makeStatus } from "../test/analysisJobFixtures";
import { AnalysisApiError } from "./analysisClientErrors";

describe("parseAnalysisStatusResponse", () => {
  it("validates shared schema responses", () => {
    const view = parseAnalysisStatusResponse(makeStatus());
    expect(view.applicationRequestId).toBeTruthy();
    expect(view.statusSequence).toBe(5);
    expect(view.pollAfterMs).toBe(2000);
  });

  it("rejects invalid responses", () => {
    expect(() => parseAnalysisStatusResponse({ status: "nope" })).toThrow(AnalysisApiError);
  });
});

describe("mergeAnalysisJobView", () => {
  it("retains highest status sequence", () => {
    const a = makeJob({ sequenceNumber: 2, status: "queued", statusLabel: "Queued" });
    const b = makeJob({
      sequenceNumber: 5,
      status: "analyzing_gameplay",
      statusLabel: "Analyzing gameplay",
    });
    const merged = mergeAnalysisJobView(a, b);
    expect(merged.accepted).toBe(true);
    expect(merged.next.statusSequence).toBe(5);
    expect(merged.next.status).toBe("analyzing_gameplay");
  });

  it("ignores lower sequence including suspicious lower terminal", () => {
    const current = makeJob({
      sequenceNumber: 8,
      status: "analyzing_gameplay",
      statusLabel: "Analyzing gameplay",
    });
    const staleTerminal = makeJob({
      sequenceNumber: 3,
      status: "failed",
      statusLabel: "Analysis failed",
      terminal: true,
      pollAfterMs: null,
      reportReady: false,
    });
    const merged = mergeAnalysisJobView(current, staleTerminal);
    expect(merged.accepted).toBe(false);
    expect(merged.next.status).toBe("analyzing_gameplay");
  });

  it("updates safe metadata on equal sequence", () => {
    const current = makeJob({
      sequenceNumber: 4,
      degraded: false,
      pollAfterMs: 2000,
      updatedAt: "2026-07-31T12:00:00.000Z",
    });
    const same = makeJob({
      sequenceNumber: 4,
      degraded: true,
      pollAfterMs: 5000,
      updatedAt: "2026-07-31T12:00:30.000Z",
      message: "Still working",
    });
    const merged = mergeAnalysisJobView(current, same);
    expect(merged.reason).toBe("equal_meta");
    expect(merged.next.degraded).toBe(true);
    expect(merged.next.pollAfterMs).toBe(5000);
    expect(merged.next.status).toBe(current.status);
  });
});

describe("shouldPollJob", () => {
  it("does not poll terminal, confirmation, or null poll", () => {
    expect(shouldPollJob(makeJob({ terminal: true, pollAfterMs: null, status: "completed" }))).toBe(
      false,
    );
    expect(
      shouldPollJob(
        makeJob({
          status: "awaiting_player_confirmation",
          userActionRequired: true,
          pollAfterMs: null,
        }),
      ),
    ).toBe(false);
    expect(shouldPollJob(makeJob({ pollAfterMs: null }))).toBe(false);
    expect(shouldPollJob(makeJob({ pollAfterMs: 2000 }))).toBe(true);
  });
});

describe("toAnalysisJobView", () => {
  it("maps sequenceNumber to statusSequence and does not invent failed state", () => {
    const view = toAnalysisJobView(
      makeStatus({ degraded: true, status: "analyzing_gameplay", statusLabel: "Analyzing gameplay" }),
    );
    expect(view.statusSequence).toBe(5);
    expect(view.degraded).toBe(true);
    expect(view.status).toBe("analyzing_gameplay");
  });
});
