import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, render } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import AnalysisStatus from "./AnalysisStatus";
import AnalysisReport from "./AnalysisReport";
import { makeJob, makeStatus } from "../test/analysisJobFixtures";
import type { AnalysisJobView } from "../lib/analysisJobView";

const getAnalysisStatus = vi.fn();
const getAnalysisReport = vi.fn();
const cancelAnalysis = vi.fn();
const submitProviderPlayerConfirmation = vi.fn();

vi.mock("../lib/analysisClient", () => ({
  getAnalysisStatus: (...args: unknown[]) => getAnalysisStatus(...args),
  getAnalysisReport: (...args: unknown[]) => getAnalysisReport(...args),
  cancelAnalysis: (...args: unknown[]) => cancelAnalysis(...args),
  submitProviderPlayerConfirmation: (...args: unknown[]) =>
    submitProviderPlayerConfirmation(...args),
  defaultAnalysisStatusApi: {
    getAnalysisStatus: (...args: unknown[]) => getAnalysisStatus(...args as [string, AbortSignal?]),
  },
}));

vi.mock("../lib/playerIdentificationApi", () => ({
  getPlayerIdentification: vi.fn(async () => ({
    candidates: [{ candidateId: "cand-1", displayLabel: "Skater 19" }],
  })),
}));

vi.mock("../lib/apiBase", () => ({
  API_BASE_URL: "http://localhost:3001",
  USE_BACKEND_REPORTS: true,
}));

function renderStatus(route: string) {
  return render(
    <MemoryRouter initialEntries={[route]}>
      <Routes>
        <Route path="/analysis/:applicationRequestId" element={<AnalysisStatus />} />
        <Route path="/analysis/:applicationRequestId/confirm-player" element={<AnalysisStatus />} />
        <Route path="/analysis/:applicationRequestId/report" element={<AnalysisReport />} />
        <Route path="/analysis-status" element={<AnalysisStatus />} />
        <Route path="/upload" element={<div>upload</div>} />
        <Route path="/scorecard" element={<div>scorecard</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("AnalysisStatus durable route", () => {
  it("renders by application request ID and loads job on direct entry", async () => {
    getAnalysisStatus.mockResolvedValue(
      makeJob({
        applicationRequestId: "req-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
        status: "analyzing_gameplay",
        statusLabel: "Analyzing gameplay",
        sequenceNumber: 4,
      }),
    );
    renderStatus("/analysis/req-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
    await waitFor(() => {
      expect(screen.getByTestId("analysis-status-label")).toHaveTextContent("Analyzing gameplay");
    });
    expect(getAnalysisStatus).toHaveBeenCalledWith(
      "req-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      expect.any(AbortSignal),
    );
    expect(screen.getByTestId("analysis-live-region")).toBeInTheDocument();
    expect(screen.getByTestId("analysis-stage-indicator")).toBeInTheDocument();
  });

  it("handles malformed request ID without storage", async () => {
    renderStatus("/analysis/bad!");
    await waitFor(() => {
      expect(screen.getByTestId("analysis-access-error")).toHaveTextContent(
        "We could not access this analysis.",
      );
    });
    expect(getAnalysisStatus).not.toHaveBeenCalled();
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
  });

  it("shows confirmation panel after reload without navigation state", async () => {
    getAnalysisStatus.mockResolvedValue(
      makeJob({
        status: "awaiting_player_confirmation",
        statusLabel: "Player confirmation needed",
        userActionRequired: true,
        pollAfterMs: null,
        cancellationAvailable: false,
      }),
    );
    renderStatus("/analysis/req-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/confirm-player");
    await waitFor(() => {
      expect(screen.getByTestId("provider-confirmation-panel")).toBeInTheDocument();
    });
    // One load — no continuous polling for confirmation.
    await new Promise((r) => setTimeout(r, 20));
    expect(getAnalysisStatus.mock.calls.length).toBe(1);
  });

  it("submits provider confirmation and resumes same analysis", async () => {
    getAnalysisStatus
      .mockResolvedValueOnce(
        makeJob({
          status: "awaiting_player_confirmation",
          statusLabel: "Player confirmation needed",
          userActionRequired: true,
          pollAfterMs: null,
          sequenceNumber: 6,
        }),
      )
      .mockResolvedValue(
        makeJob({
          status: "validating_player_identity",
          statusLabel: "Validating player tracking",
          sequenceNumber: 7,
          pollAfterMs: 2000,
        }),
      );
    submitProviderPlayerConfirmation.mockResolvedValue(
      makeJob({
        status: "validating_player_identity",
        statusLabel: "Validating player tracking",
        sequenceNumber: 7,
        pollAfterMs: 2000,
      }),
    );
    renderStatus("/analysis/req-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
    await waitFor(() => screen.getByTestId("provider-confirmation-panel"));
    await waitFor(() => {
      expect(screen.getByRole("radio", { name: /skater 19/i })).toBeInTheDocument();
    });
    const confirmBtn = screen.getByRole("button", { name: /confirm player and continue/i });
    await waitFor(() => expect(confirmBtn).not.toBeDisabled());
    fireEvent.click(confirmBtn);
    await waitFor(() => {
      expect(submitProviderPlayerConfirmation).toHaveBeenCalledWith(
        "req-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
        { selectedCandidateId: "cand-1" },
      );
    });
    await waitFor(() => {
      expect(screen.getByTestId("analysis-status-label")).toHaveTextContent(
        "Validating player tracking",
      );
    });
  });

  it("links report-ready state to report route", async () => {
    getAnalysisStatus.mockResolvedValue(
      makeJob({
        status: "completed",
        statusLabel: "Complete",
        terminal: true,
        reportReady: true,
        reportAvailable: true,
        pollAfterMs: null,
        cancellationAvailable: false,
      }),
    );
    renderStatus("/analysis/req-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
    await waitFor(() => screen.getByTestId("view-coaching-report"));
    expect(screen.queryByTestId("cancel-analysis")).toBeNull();
    fireEvent.click(screen.getByTestId("view-coaching-report"));
  });

  it("does not optimistically cancel; disables duplicate clicks", async () => {
    let resolveCancel: ((job: AnalysisJobView) => void) | null = null;
    getAnalysisStatus.mockResolvedValue(
      makeJob({
        status: "analyzing_gameplay",
        cancellationAvailable: true,
        pollAfterMs: null,
      }),
    );
    cancelAnalysis.mockImplementation(
      () =>
        new Promise<AnalysisJobView>((resolve) => {
          resolveCancel = resolve;
        }),
    );
    renderStatus("/analysis/req-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
    await waitFor(() => screen.getByTestId("cancel-analysis"));
    const btn = screen.getByTestId("cancel-analysis");
    fireEvent.click(btn);
    await waitFor(() => expect(btn).toBeDisabled());
    // Still analyzing until backend confirms.
    expect(screen.getByTestId("analysis-status-label")).toHaveTextContent("Analyzing gameplay");
    resolveCancel?.(
      makeJob({
        status: "cancelled",
        statusLabel: "Cancelled",
        terminal: true,
        pollAfterMs: null,
        cancellationAvailable: false,
      }),
    );
    await waitFor(() => {
      expect(screen.getByTestId("analysis-cancelled-panel")).toBeInTheDocument();
    });
  });

  it("shows degraded message without marking failed", async () => {
    getAnalysisStatus.mockResolvedValue(
      makeJob({
        status: "analyzing_gameplay",
        statusLabel: "Analyzing gameplay",
        degraded: true,
        pollAfterMs: null,
      }),
    );
    renderStatus("/analysis/req-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
    await waitFor(() => screen.getByTestId("analysis-degraded-banner"));
    expect(screen.getByTestId("analysis-status-label")).toHaveTextContent("Analyzing gameplay");
    expect(screen.getByTestId("analysis-status-label")).not.toHaveTextContent("failed");
  });

  it("shows safe failed error without raw provider body", async () => {
    getAnalysisStatus.mockResolvedValue(
      makeJob({
        status: "failed",
        statusLabel: "Analysis failed",
        terminal: true,
        pollAfterMs: null,
        errorMessage: "The analysis could not be completed.",
        errorCode: "ANALYSIS_FAILED",
        cancellationAvailable: false,
      }),
    );
    renderStatus("/analysis/req-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
    await waitFor(() => screen.getByTestId("analysis-failed-panel"));
    expect(screen.getByTestId("analysis-failed-panel").textContent).not.toMatch(
      /stack|traceback|SCOTTY_BASE_URL|Bearer/i,
    );
  });

  it("announces recovered state once via live region", async () => {
    getAnalysisStatus.mockResolvedValue(
      makeJob({
        status: "finalizing",
        statusLabel: "Finalizing report",
        sequenceNumber: 9,
        pollAfterMs: null,
      }),
    );
    renderStatus("/analysis/req-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
    await waitFor(() => {
      expect(screen.getByTestId("analysis-live-region")).toHaveTextContent("Finalizing report");
    });
  });
});

describe("AnalysisReport route (smoke from status suite)", () => {
  it("shows not-ready for incomplete jobs without fetching report", async () => {
    getAnalysisStatus.mockResolvedValue(
      makeJob({
        status: "analyzing_gameplay",
        reportAvailable: false,
        pollAfterMs: null,
      }),
    );
    renderStatus("/analysis/req-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/report");
    await waitFor(() => {
      expect(screen.getByTestId("report-not-ready")).toBeInTheDocument();
    });
    expect(getAnalysisReport).not.toHaveBeenCalled();
  });
});

describe("submission navigation helpers", () => {
  it("legacy query route still recovers without navigation state", async () => {
    getAnalysisStatus.mockResolvedValue(
      makeJob({
        applicationRequestId: "req-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
        status: "queued",
        statusLabel: "Queued",
        pollAfterMs: null,
      }),
    );
    renderStatus("/analysis-status?requestId=req-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
    await waitFor(() => {
      expect(getAnalysisStatus).toHaveBeenCalled();
    });
  });
});

// Ensure fixture schema stays aligned.
void makeStatus;
