import { minimalScottyReport } from "../../shared/scotty/fixtures";
import type { AnalysisReportResponse } from "../../shared/scotty/report-envelope";
import type { ScottyReport } from "../../shared/scotty/report";

export function makeReportPayload(
  overrides: Partial<Omit<AnalysisReportResponse, "report">> & {
    report?: Partial<ScottyReport>;
  } = {},
): AnalysisReportResponse {
  const { report: reportOverrides, ...envelope } = overrides;
  const report = minimalScottyReport(reportOverrides);
  return {
    applicationRequestId: "req-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    uploadId: report.uploadId,
    report,
    sourceMediaAvailable: true,
    sourceMediaExpiresAt: "2026-08-01T12:00:00.000Z",
    mediaClassification: "short_clip",
    mediaDurationSec: 90,
    platform: "xbox_series",
    controlScheme: "skill_stick",
    gameMode: "eashl",
    simulatorMode: true,
    ...envelope,
  };
}

export function makePlaystationReportPayload(): AnalysisReportResponse {
  return makeReportPayload({
    platform: "playstation_5",
    controlScheme: "total_control",
    report: {
      controlGuidance: [
        {
          gameTitle: "NHL 25",
          platform: "playstation_5",
          controlScheme: "total_control",
          canonicalMechanic: "gap_control",
          inputSequence: [
            { order: 0, input: "Left Stick", behavior: "motion" },
            { order: 1, input: "R2", behavior: "hold" },
          ],
          timingCue: "Match gap before the blue line",
          verificationStatus: "verified",
          verifiedAt: "2026-07-31T12:00:00.000Z",
          sourceConfidence: "high",
          platformComparison: false,
        },
      ],
      playerAttribution: {
        position: "LW",
        jerseyNumber: 88,
        indicatorColor: "orange",
        confirmationState: "confirmed",
      },
      practiceDrills: [
        {
          drillId: "ps-drill-1",
          name: "PS gap reps",
          objective: "Hold a tight gap",
          gameTitle: "NHL 25",
          platform: "playstation_5",
          controlScheme: "total_control",
          position: "LW",
          setup: "Offline practice",
          requiredMechanics: ["gap_control"],
          verifiedControlInputs: [
            { order: 0, input: "Left Stick", behavior: "motion" },
            { order: 1, input: "R2", behavior: "hold" },
          ],
          repetitionTarget: "10 reps",
          successCriteria: "Force dump-ins",
          commonErrors: ["Over-committing"],
        },
      ],
    },
  });
}

export function makeFaceoffReportPayload(): AnalysisReportResponse {
  return makeReportPayload({
    mediaClassification: "full_game",
    mediaDurationSec: 1200,
    report: {
      faceoffAnalysis: {
        faceoffCount: 10,
        wins: 6,
        losses: 4,
        winPercentage: 60,
        detectedTechniques: ["stance_setup"],
        timingAssessment: "Slightly late on the stick press",
        counterSelection: "Use a backhand counter on left draws",
        strengths: ["Stance"],
        improvements: ["Timing"],
        practiceDrillId: "drill-1",
        confidence: "moderate",
      },
      playerAttribution: {
        position: "C",
        jerseyNumber: 19,
        indicatorColor: "blue",
        confirmationState: "confirmed",
      },
    },
  });
}
