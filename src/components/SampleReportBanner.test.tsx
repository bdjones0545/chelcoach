import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { useEffect } from "react";
import { AnalysisProvider, useAnalysis } from "../state/AnalysisContext";
import { PremiumProvider } from "../state/PremiumContext";
import { ReportProvider } from "../state/ReportContext";
import Scorecard from "../screens/Scorecard";
import FilmPreview from "../screens/FilmPreview";
import Paywall from "../screens/Paywall";
import FilmRoom from "../screens/FilmRoom";

/** The Landing "View Demo Report" button marks the sample as analyzed before showing it. */
function MarkAnalyzed({ children }: { children: React.ReactNode }) {
  const { hasAnalysis, markAnalyzed } = useAnalysis();
  useEffect(() => {
    if (!hasAnalysis) markAnalyzed();
  }, [hasAnalysis, markAnalyzed]);
  return hasAnalysis ? <>{children}</> : null;
}

function wrap(node: React.ReactNode) {
  return (
    <MemoryRouter>
      <AnalysisProvider>
        <PremiumProvider>
          <ReportProvider>
            <MarkAnalyzed>{node}</MarkAnalyzed>
          </ReportProvider>
        </PremiumProvider>
      </AnalysisProvider>
    </MemoryRouter>
  );
}

describe("public demo loop is labelled as a sample", () => {
  it.each([
    ["Scorecard", <Scorecard key="s" />],
    ["FilmPreview", <FilmPreview key="f" />],
    ["Paywall", <Paywall key="p" />],
    ["FilmRoom", <FilmRoom key="r" />],
  ])("%s carries the sample banner", (_name, node) => {
    render(wrap(node));
    expect(screen.getAllByTestId("sample-report-banner").length).toBeGreaterThan(0);
  });

  it("the sample scorecard never claims to be the visitor's own upload or promise no sign-up", () => {
    render(wrap(<Scorecard />));
    expect(screen.queryByText(/your last uploaded game/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/no sign-up/i)).not.toBeInTheDocument();
  });

  it("the paywall does not offer a trial or billing that does not exist", () => {
    render(wrap(<Paywall />));
    expect(screen.queryByText(/free trial/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/cancel anytime/i)).not.toBeInTheDocument();
  });
});
