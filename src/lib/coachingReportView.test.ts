import { describe, expect, it } from "vitest";
import { buildCoachingReportView } from "./coachingReportView";
import { qualitativeScoreLabel } from "./reportScoreLabels";
import {
  makeFaceoffReportPayload,
  makePlaystationReportPayload,
  makeReportPayload,
} from "../test/reportFixtures";

describe("buildCoachingReportView", () => {
  it("builds header, executive summary, strengths, priorities, and practice plan", () => {
    const view = buildCoachingReportView(makeReportPayload());
    expect(view.header.title).toBe("Scotty’s Gameplay Review");
    expect(view.header.gameTitle).toBe("NHL 25");
    expect(view.header.platform).toMatch(/Xbox/i);
    expect(view.header.controlScheme).toMatch(/Skill Stick/i);
    expect(view.header.position).toBe("Center");
    expect(view.executive.strongestArea).toBeTruthy();
    expect(view.strengths.length).toBeGreaterThan(0);
    expect(view.priorities[0]?.rank).toBe(1);
    expect(view.practiceDrills.length).toBeGreaterThan(0);
    expect(view.practiceDrills.length).toBeLessThanOrEqual(3);
    expect(view.nextGameFocus.primaryFocus).toBeTruthy();
    expect(view.overallScore).toBeNull();
  });

  it("omits faceoffs when count is zero / absent", () => {
    const view = buildCoachingReportView(makeReportPayload());
    expect(view.faceoffs).toBeNull();
    expect(view.navigation.some((n) => n.id === "faceoffs")).toBe(false);
  });

  it("renders faceoff section when valid faceoff data exists", () => {
    const view = buildCoachingReportView(makeFaceoffReportPayload());
    expect(view.faceoffs).not.toBeNull();
    expect(view.faceoffs!.wins + view.faceoffs!.losses).toBeLessThanOrEqual(
      view.faceoffs!.faceoffCount,
    );
    expect(view.faceoffs!.winRateLabel).toBe("60%");
    expect(view.navigation.some((n) => n.id === "faceoffs")).toBe(true);
  });

  it("keeps Xbox and PlayStation controls isolated", () => {
    const xbox = buildCoachingReportView(makeReportPayload());
    expect(xbox.controls.every((c) => c.platform.startsWith("xbox"))).toBe(true);
    expect(JSON.stringify(xbox.controls)).not.toMatch(/\bR2\b|\bL2\b|\bCross\b/);

    const ps = buildCoachingReportView(makePlaystationReportPayload());
    expect(ps.controls.every((c) => c.platform.startsWith("playstation"))).toBe(true);
    expect(JSON.stringify(ps.controls)).not.toMatch(/\bRT\b|\bLT\b|\bLB\b/);
    expect(ps.positionCoaching?.title).toMatch(/Wing/i);
    expect(ps.positionCoaching?.title).not.toMatch(/Goalie/i);
  });

  it("does not invent verified buttons when verification is absent", () => {
    const view = buildCoachingReportView(
      makeReportPayload({
        report: {
          controlGuidance: [
            {
              gameTitle: "NHL 25",
              platform: "xbox_series",
              controlScheme: "skill_stick",
              canonicalMechanic: "puck_support",
              inputSequence: [{ order: 0, input: "LS", behavior: "motion" }],
              verificationStatus: "unverified",
              sourceConfidence: "low",
              platformComparison: false,
            },
          ],
        },
      }),
    );
    expect(view.controls[0]?.hasVerifiedInputs).toBe(false);
    expect(view.controls[0]?.steps.length).toBe(0);
  });

  it("handles deleted source media without losing report value", () => {
    const view = buildCoachingReportView(
      makeReportPayload({
        sourceMediaAvailable: false,
        sourceMediaExpiresAt: null,
      }),
    );
    expect(view.sourceMedia.available).toBe(false);
    expect(view.sourceMedia.notice).toMatch(/deleted according to the retention policy/i);
    expect(view.moments.length).toBeGreaterThan(0);
    expect(view.moments[0]?.timestampSec).not.toBeNull();
  });

  it("bounds initial priorities and links drills", () => {
    const view = buildCoachingReportView(
      makeReportPayload({
        report: {
          priorityImprovements: [
            "Gap control on entries",
            "Neutral-zone exits",
            "Weak-side support",
            "Stick positioning",
            "Backcheck timing",
          ],
        },
      }),
    );
    expect(view.priorities.length).toBe(5);
    expect(view.initialPriorityCount).toBe(3);
    expect(view.practiceDrills.some((d) => d.linkedPriorityId || d.whySelected)).toBe(true);
  });

  it("omits navigation for absent sections", () => {
    const view = buildCoachingReportView(
      makeReportPayload({
        report: {
          strengths: [],
          controlGuidance: [],
          practiceDrills: [],
          playerSpecificObservations: [],
        },
      }),
    );
    expect(view.navigation.some((n) => n.id === "strengths")).toBe(false);
    expect(view.navigation.some((n) => n.id === "controls")).toBe(false);
    expect(view.navigation.some((n) => n.id === "practice")).toBe(false);
    expect(view.navigation.some((n) => n.id === "moments")).toBe(false);
  });

  it("does not expose provider/storage secrets in presentation", () => {
    const view = buildCoachingReportView(makeReportPayload());
    const blob = JSON.stringify(view);
    expect(blob).not.toMatch(/SCOTTY_BASE_URL|storageObjectKey|idempotencyKey|requestFingerprint/);
  });
});

describe("qualitativeScoreLabel", () => {
  it("centralizes score thresholds", () => {
    expect(qualitativeScoreLabel(95)).toBe("Elite");
    expect(qualitativeScoreLabel(80)).toBe("Strong");
    expect(qualitativeScoreLabel(60)).toBe("Developing");
    expect(qualitativeScoreLabel(40)).toBe("Needs attention");
  });
});
