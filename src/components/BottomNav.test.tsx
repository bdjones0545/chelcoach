import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { useEffect } from "react";
import BottomNav from "./BottomNav";
import { AnalysisProvider, useAnalysis } from "../state/AnalysisContext";

function Probe() {
  return <div data-testid="where">{useLocation().pathname}</div>;
}

function SetCurrent({ id }: { id: string | null }) {
  const { setCurrentAnalysisId } = useAnalysis();
  useEffect(() => setCurrentAnalysisId(id), [id, setCurrentAnalysisId]);
  return null;
}

function mount(active: "upload" | "analysis" | "sample" = "upload", currentId: string | null = null) {
  return render(
    <MemoryRouter initialEntries={["/start"]}>
      <AnalysisProvider>
        <SetCurrent id={currentId} />
        <BottomNav active={active} />
        <Routes>
          <Route path="*" element={<Probe />} />
        </Routes>
      </AnalysisProvider>
    </MemoryRouter>,
  );
}

describe("BottomNav", () => {
  it("offers only screens that exist — no Tactics, Roster, or AI Insights", () => {
    mount();
    expect(screen.getAllByRole("button").map((b) => b.getAttribute("aria-label") ?? b.querySelector("span:last-child")?.textContent)).toEqual([
      "Upload",
      "Analysis",
      "Sample report",
    ]);
    expect(screen.queryByText(/tactics|roster|ai insights/i)).not.toBeInTheDocument();
  });

  it("Upload → /upload, Sample report → /scorecard", () => {
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Upload" }));
    expect(screen.getByTestId("where")).toHaveTextContent("/upload");
    fireEvent.click(screen.getByRole("button", { name: "Sample report" }));
    expect(screen.getByTestId("where")).toHaveTextContent("/scorecard");
  });

  it("Analysis → the analysis this tab started, or the status screen when there is none", () => {
    const none = mount();
    fireEvent.click(screen.getByRole("button", { name: "Analysis" }));
    expect(screen.getByTestId("where")).toHaveTextContent("/analysis-status");
    none.unmount();

    mount("upload", "req-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
    fireEvent.click(screen.getByRole("button", { name: "Analysis" }));
    expect(screen.getByTestId("where")).toHaveTextContent("/analysis/req-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
    expect(window.sessionStorage.length).toBe(0);
    expect(window.localStorage.length).toBe(0);
  });

  it("marks the active destination", () => {
    mount("sample");
    expect(screen.getByRole("button", { name: "Sample report" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("button", { name: "Upload" })).not.toHaveAttribute("aria-current");
  });
});
