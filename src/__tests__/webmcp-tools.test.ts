/**
 * ChelCoach's WebMCP tool surface.
 *
 * The important assertions here are the two gates. ChelCoach shows a coaching
 * moment's teaser to everyone and its full breakdown only when unlocked, and
 * the film room needs a completed analysis. If either gate ever loosens in the
 * tool layer, WebMCP becomes a cleaner way around the paywall than the UI —
 * which in the UI is only a CSS blur — so these are asserted, not assumed.
 */
import { describe, expect, it } from "vitest";

import { mockReport, type GameReport } from "../data/mockData";
import { buildChelCoachTools, type ChelCoachSnapshot } from "../webmcp/tools";

type ToolResult = { isError?: boolean };

function textOf(result: unknown): string {
  const block = (result as { content?: { text?: string }[] }).content?.[0];
  if (typeof block?.text !== "string") throw new Error("tool returned no text content");
  return block.text;
}

const baseline: ChelCoachSnapshot = {
  report: mockReport,
  source: "mock",
  isPremium: false,
  hasAnalysis: false,
};

function toolsFor(overrides: Partial<ChelCoachSnapshot> = {}) {
  const snapshot = { ...baseline, ...overrides };
  const built = buildChelCoachTools(() => snapshot);
  const find = (name: string) => {
    const tool = built.find((candidate) => candidate.name === name);
    if (!tool) throw new Error(`no such tool: ${name}`);
    return tool;
  };
  return {
    all: built,
    call: async (name: string, input: Record<string, unknown> = {}) =>
      (await find(name).execute(input)) as ToolResult,
    read: async (name: string, input: Record<string, unknown> = {}) =>
      JSON.parse(textOf(await find(name).execute(input))),
  };
}

const anonymous = toolsFor();
const analyzed = toolsFor({ hasAnalysis: true });
const premium = toolsFor({ hasAnalysis: true, isPremium: true });

describe("the tool surface", () => {
  it("exposes exactly the four intended tools", () => {
    expect(anonymous.all.map((tool) => tool.name).sort()).toEqual([
      "chelcoach_get_analysis_status",
      "chelcoach_get_film_room_breakdown",
      "chelcoach_get_scorecard",
      "chelcoach_list_coaching_moments",
    ]);
  });

  it("declares every tool read-only", () => {
    for (const tool of anonymous.all) {
      expect(tool.annotations?.readOnlyHint).toBe(true);
      expect(tool.inputSchema).toBeDefined();
    }
  });

  it("names every tool with a reading verb", () => {
    for (const tool of anonymous.all) {
      expect(tool.name).toMatch(/^chelcoach_(get|list)_/);
    }
  });

  it("leaves the report untouched when every tool is executed", async () => {
    const report = structuredClone(mockReport) as GameReport;
    const before = JSON.stringify(report);
    const built = buildChelCoachTools(() => ({
      report,
      source: "mock",
      isPremium: true,
      hasAnalysis: true,
    }));
    for (const tool of built) await tool.execute({});
    expect(JSON.stringify(report)).toBe(before);
  });
});

describe("the premium gate", () => {
  it("withholds the full breakdown of locked moments", async () => {
    const result = await anonymous.read("chelcoach_list_coaching_moments");
    const locked = result.moments.filter((m: { locked: boolean }) => m.locked);
    expect(locked.length).toBeGreaterThan(0);
    for (const moment of locked) {
      expect(moment.fullBreakdown).toBeUndefined();
      expect(moment.teaser).toBeTruthy();
    }
  });

  it("never leaks a locked breakdown anywhere in the payload", async () => {
    // Serialize the whole response and check no locked moment's text appears,
    // in case a breakdown ever escapes through a field other than fullBreakdown.
    const raw = textOf(
      await anonymous.call("chelcoach_list_coaching_moments"),
    );
    const lockedSources = mockReport.coachingMoments.filter(
      (moment) => moment.type !== "great",
    );
    expect(lockedSources.length).toBeGreaterThan(0);
    for (const moment of lockedSources) {
      expect(raw).not.toContain(moment.fullBreakdown);
    }
  });

  it("reports how many moments are locked and why", async () => {
    const result = await anonymous.read("chelcoach_list_coaching_moments");
    expect(result.lockedCount).toBeGreaterThan(0);
    expect(result.note).toContain("premium");
  });

  it("opens every breakdown once premium is unlocked", async () => {
    const result = await premium.read("chelcoach_list_coaching_moments");
    expect(result.lockedCount).toBe(0);
    for (const moment of result.moments) {
      expect(moment.locked).toBe(false);
      expect(moment.fullBreakdown).toBeTruthy();
    }
  });

  it("leaves highlight moments open to everyone, matching the UI", async () => {
    const result = await anonymous.read("chelcoach_list_coaching_moments");
    const great = result.moments.filter((m: { type: string }) => m.type === "great");
    expect(great.length).toBeGreaterThan(0);
    for (const moment of great) expect(moment.locked).toBe(false);
  });

  it("applies the gate to a filtered list too", async () => {
    const result = await anonymous.read("chelcoach_list_coaching_moments", {
      type: "missed",
    });
    for (const moment of result.moments) {
      expect(moment.type).toBe("missed");
      expect(moment.fullBreakdown).toBeUndefined();
    }
  });
});

describe("the analysis gate", () => {
  it("refuses the film room until an analysis exists", async () => {
    const result = await anonymous.read("chelcoach_get_film_room_breakdown");
    expect(result.error).toContain("No completed analysis");
    expect(result.commentary).toBeUndefined();
  });

  it("opens the film room once an analysis exists", async () => {
    const result = await analyzed.read("chelcoach_get_film_room_breakdown");
    expect(result.error).toBeUndefined();
    expect(result.nextGameFocus).toBeTruthy();
    expect(result.timelineMarkers.length).toBeGreaterThan(0);
  });

  it("moves independently of the premium gate", async () => {
    // An analysis opens the film room without unlocking coaching breakdowns.
    const film = await analyzed.read("chelcoach_get_film_room_breakdown");
    const moments = await analyzed.read("chelcoach_list_coaching_moments");
    expect(film.error).toBeUndefined();
    expect(moments.lockedCount).toBeGreaterThan(0);
  });
});

describe("status and scorecard", () => {
  it("says plainly when the report is the built-in sample", async () => {
    const status = await anonymous.read("chelcoach_get_analysis_status");
    expect(status.reportSource).toBe("mock");
    expect(status.note).toContain("not a real analysis");
  });

  it("says so when the report came from the backend", async () => {
    const status = await toolsFor({ source: "api" }).read(
      "chelcoach_get_analysis_status",
    );
    expect(status.note).toContain("ChelCoach backend");
  });

  it("returns the scorecard with every graded metric", async () => {
    const scorecard = await anonymous.read("chelcoach_get_scorecard");
    expect(scorecard.chelRating).toBe(mockReport.scorecard.chelRating);
    expect(scorecard.metrics).toHaveLength(mockReport.scorecard.metrics.length);
    expect(scorecard.biggestWeakness).toBeTruthy();
  });

  it("does not gate the scorecard, which is the free tier's product", async () => {
    const scorecard = await anonymous.read("chelcoach_get_scorecard");
    expect(scorecard.error).toBeUndefined();
  });
});
