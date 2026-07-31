import { describe, expect, it } from "vitest";
import { scottyJobStatusSchema } from "../../shared/scotty/enums";
import {
  ANALYSIS_STATUS_PRESENTATION,
  analysisStagesForStatus,
  getAnalysisStatusPresentation,
  presentationContainsProviderLeak,
  statusLabel,
} from "./analysisStatusPresentation";

describe("ANALYSIS_STATUS_PRESENTATION", () => {
  it("covers every canonical status", () => {
    for (const status of scottyJobStatusSchema.options) {
      expect(ANALYSIS_STATUS_PRESENTATION[status]).toBeTruthy();
      expect(getAnalysisStatusPresentation(status).label.length).toBeGreaterThan(0);
    }
  });

  it("has no provider-specific leak strings", () => {
    for (const status of scottyJobStatusSchema.options) {
      const p = ANALYSIS_STATUS_PRESENTATION[status];
      expect(presentationContainsProviderLeak(p.label)).toBe(false);
      expect(presentationContainsProviderLeak(p.description)).toBe(false);
      expect(p.description).not.toMatch(/anthropic|openai|externalScotty|idempotency/i);
    }
  });

  it("statusLabel maps analyzing_gameplay", () => {
    expect(statusLabel("analyzing_gameplay")).toBe("Analyzing gameplay");
  });
});

describe("analysisStagesForStatus", () => {
  it("has no percentage fields", () => {
    const stages = analysisStagesForStatus("analyzing_gameplay");
    expect(JSON.stringify(stages)).not.toMatch(/%|percent|progress/i);
    expect(stages.some((s) => s.state === "current")).toBe(true);
  });

  it("marks completed stages for completed jobs", () => {
    const stages = analysisStagesForStatus("completed");
    expect(stages.every((s) => s.state === "complete")).toBe(true);
  });
});
