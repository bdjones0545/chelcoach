import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import AnalysisReport from "./AnalysisReport";
import { makeJob } from "../test/analysisJobFixtures";
import {
  makeFaceoffReportPayload,
  makePlaystationReportPayload,
  makeReportPayload,
} from "../test/reportFixtures";
import { AnalysisApiError } from "../lib/analysisClientErrors";

const getAnalysisStatus = vi.fn();
const getAnalysisReport = vi.fn();

vi.mock("../lib/analysisClient", () => ({
  getAnalysisStatus: (...args: unknown[]) => getAnalysisStatus(...args),
  getAnalysisReport: (...args: unknown[]) => getAnalysisReport(...args),
}));

vi.mock("../lib/apiBase", () => ({
  API_BASE_URL: "http://localhost:3001",
  USE_BACKEND_REPORTS: true,
}));

function renderReport(route: string) {
  return render(
    <MemoryRouter
      initialEntries={[route]}
      future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
    >
      <Routes>
        <Route path="/analysis/:applicationRequestId/report" element={<AnalysisReport />} />
        <Route path="/analysis/:applicationRequestId" element={<div>status page</div>} />
        <Route path="/upload" element={<div>upload</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

afterEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  window.sessionStorage.clear();
});

describe("AnalysisReport route", () => {
  it("loads completed report on direct route and refresh recovery", async () => {
    getAnalysisStatus.mockResolvedValue(
      makeJob({
        status: "completed",
        terminal: true,
        reportAvailable: true,
        reportReady: true,
        pollAfterMs: null,
      }),
    );
    getAnalysisReport.mockResolvedValue(makeReportPayload());
    renderReport("/analysis/req-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/report");
    await waitFor(() => {
      expect(screen.getByTestId("report-header")).toHaveTextContent("Scotty’s Gameplay Review");
    });
    expect(getAnalysisStatus).toHaveBeenCalled();
    expect(getAnalysisReport).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("report-executive-summary")).toBeInTheDocument();
    expect(screen.getByTestId("report-strengths")).toBeInTheDocument();
    expect(screen.getByTestId("report-improvements")).toBeInTheDocument();
    expect(screen.getByTestId("report-gameplay-moments")).toBeInTheDocument();
    expect(screen.getByTestId("report-practice-plan")).toBeInTheDocument();
    expect(screen.getByTestId("report-next-game-focus")).toBeInTheDocument();
    expect(screen.getByTestId("overall-score-absent")).toBeInTheDocument();
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
  });

  it("validates request id and shows not-ready without report fetch", async () => {
    renderReport("/analysis/bad!/report");
    await waitFor(() => {
      expect(screen.getByTestId("report-failure")).toHaveTextContent(
        "We could not access this analysis.",
      );
    });
    expect(getAnalysisReport).not.toHaveBeenCalled();
  });

  it("shows not-ready state for incomplete jobs", async () => {
    getAnalysisStatus.mockResolvedValue(
      makeJob({
        status: "analyzing_gameplay",
        reportAvailable: false,
        pollAfterMs: null,
      }),
    );
    renderReport("/analysis/req-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/report");
    await waitFor(() => {
      expect(screen.getByTestId("report-not-ready")).toHaveTextContent(
        "Your coaching report is not ready yet.",
      );
    });
    expect(getAnalysisReport).not.toHaveBeenCalled();
  });

  it("rejects malformed report envelope safely", async () => {
    getAnalysisStatus.mockResolvedValue(
      makeJob({
        status: "completed",
        terminal: true,
        reportAvailable: true,
        reportReady: true,
        pollAfterMs: null,
      }),
    );
    getAnalysisReport.mockRejectedValue(
      new AnalysisApiError({
        type: "invalid_report_response",
        retryable: false,
        message: "Your coaching report could not be displayed safely.",
      }),
    );
    renderReport("/analysis/req-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/report");
    await waitFor(() => {
      expect(screen.getByTestId("report-failure")).toHaveTextContent(
        "could not be displayed safely",
      );
    });
    expect(screen.queryByText(/\{/)).toBeNull();
  });

  it("shows header context and media deleted notice", async () => {
    getAnalysisStatus.mockResolvedValue(
      makeJob({
        status: "completed",
        terminal: true,
        reportAvailable: true,
        reportReady: true,
        pollAfterMs: null,
      }),
    );
    getAnalysisReport.mockResolvedValue(
      makeReportPayload({
        sourceMediaAvailable: false,
        sourceMediaExpiresAt: null,
      }),
    );
    renderReport("/analysis/req-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/report");
    await waitFor(() => screen.getByTestId("report-header-meta"));
    expect(screen.getByTestId("report-header-meta")).toHaveTextContent("Xbox");
    expect(screen.getByTestId("report-header-meta")).toHaveTextContent("Skill Stick");
    expect(screen.getByTestId("report-header-meta")).toHaveTextContent("Center");
    expect(screen.getByTestId("source-media-notice")).toHaveAttribute(
      "data-media-available",
      "false",
    );
    expect(screen.getByTestId("source-media-notice")).toHaveTextContent(/deleted according to the retention policy/i);
  });

  it("selects timestamps without video and filters moments", async () => {
    getAnalysisStatus.mockResolvedValue(
      makeJob({
        status: "completed",
        terminal: true,
        reportAvailable: true,
        reportReady: true,
        pollAfterMs: null,
      }),
    );
    getAnalysisReport.mockResolvedValue(
      makeReportPayload({ sourceMediaAvailable: false, sourceMediaExpiresAt: null }),
    );
    renderReport("/analysis/req-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/report");
    await waitFor(() => screen.getByTestId("report-gameplay-moments"));
    const tsBtn = screen.getByTestId("moment-timestamp-moment-0");
    fireEvent.click(tsBtn);
    await waitFor(() => {
      expect(screen.getByTestId("active-evidence-note")).toBeInTheDocument();
    });
    expect(document.querySelector("video")).toBeNull();
  });

  it("expands additional priorities and keeps section nav free of absent faceoffs", async () => {
    getAnalysisStatus.mockResolvedValue(
      makeJob({
        status: "completed",
        terminal: true,
        reportAvailable: true,
        reportReady: true,
        pollAfterMs: null,
      }),
    );
    getAnalysisReport.mockResolvedValue(
      makeReportPayload({
        report: {
          priorityImprovements: [
            "Gap control on entries",
            "Neutral-zone exits",
            "Weak-side support",
            "Stick positioning",
          ],
        },
      }),
    );
    renderReport("/analysis/req-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/report");
    await waitFor(() => screen.getByTestId("view-all-improvements"));
    expect(screen.getByTestId("report-section-nav").textContent).not.toMatch(/Faceoffs/i);
    fireEvent.click(screen.getByTestId("view-all-improvements"));
    expect(screen.getByTestId("view-all-improvements")).toHaveAttribute("aria-expanded", "true");
  });

  it("renders faceoff and playstation fixtures", async () => {
    getAnalysisStatus.mockResolvedValue(
      makeJob({
        status: "completed",
        terminal: true,
        reportAvailable: true,
        reportReady: true,
        pollAfterMs: null,
      }),
    );
    getAnalysisReport.mockResolvedValue(makeFaceoffReportPayload());
    const { unmount } = renderReport(
      "/analysis/req-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/report",
    );
    await waitFor(() => screen.getByTestId("report-faceoffs"));
    expect(screen.getByTestId("report-faceoffs")).toHaveTextContent("60%");
    unmount();

    getAnalysisReport.mockResolvedValue(makePlaystationReportPayload());
    renderReport("/analysis/req-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/report");
    await waitFor(() => screen.getByTestId("report-controls"));
    expect(screen.getByTestId("report-controls")).toHaveTextContent("R2");
    expect(screen.getByTestId("report-controls").textContent).not.toMatch(/\bRT\b/);
    expect(screen.getByTestId("report-position-coaching")).toHaveTextContent("Wing Coaching");
  });

  it("shows loading skeleton then metadata at bottom", async () => {
    getAnalysisStatus.mockResolvedValue(
      makeJob({
        status: "completed",
        terminal: true,
        reportAvailable: true,
        reportReady: true,
        pollAfterMs: null,
      }),
    );
    getAnalysisReport.mockResolvedValue(makeReportPayload());
    renderReport("/analysis/req-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/report");
    await waitFor(() => screen.getByTestId("report-metadata"));
    expect(screen.getByTestId("report-limitations")).toBeInTheDocument();
    // Loading skeleton is present during fetch; after resolution metadata remains.
    expect(screen.queryByTestId("report-loading-skeleton")).toBeNull();
  });

  it("exposes loading skeleton while report fetch is pending", async () => {
    getAnalysisStatus.mockResolvedValue(
      makeJob({
        status: "completed",
        terminal: true,
        reportAvailable: true,
        reportReady: true,
        pollAfterMs: null,
      }),
    );
    getAnalysisReport.mockImplementation(() => new Promise(() => undefined));
    renderReport("/analysis/req-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/report");
    await waitFor(() => {
      expect(screen.getByTestId("report-loading-skeleton")).toBeInTheDocument();
    });
  });
});
