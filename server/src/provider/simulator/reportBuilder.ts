/**
 * Deterministic simulator report builder — no LLM / external APIs.
 */
import { randomUUID } from "node:crypto";
import {
  scottyReportSchema,
  type ControlGuidance,
  type PracticeDrill,
  type ScottyObservation,
  type ScottyReport,
  type SupportedPlatform,
} from "../../scottyContract";
import { resolveReportFixtureId } from "./reportFixtures";
import type { SimulatorJob } from "./types";

function clampTs(sec: number, duration: number): number {
  if (duration <= 0) throw new Error("INVALID_MEDIA_DURATION");
  return Math.min(Math.max(0.1, sec), Math.max(0.1, duration - 0.05));
}

function observationCount(job: SimulatorJob): number {
  if (job.mediaClassification === "full_game" || job.scenario === "slow_full_game") return 12;
  if (job.mediaClassification === "extended_clip") return 7;
  return 4;
}

function xboxGuidance(scheme: string): ControlGuidance {
  return {
    gameTitle: "NHL 25",
    platform: "xbox_series",
    controlScheme: scheme === "total_control" ? "total_control" : "skill_stick",
    canonicalMechanic: "gap_control",
    inputSequence: [
      { order: 0, input: "LS", behavior: "motion" },
      { order: 1, input: scheme === "total_control" ? "RT" : "A", behavior: "hold" },
    ],
    timingCue: "Match gap before the blue line",
    verificationStatus: "verified",
    verifiedAt: new Date().toISOString(),
    sourceConfidence: "high",
    platformComparison: false,
  };
}

function playstationGuidance(scheme: string): ControlGuidance {
  return {
    gameTitle: "NHL 25",
    platform: "playstation_5",
    controlScheme: scheme === "total_control" ? "total_control" : "skill_stick",
    canonicalMechanic: "gap_control",
    inputSequence: [
      { order: 0, input: "Left Stick", behavior: "motion" },
      { order: 1, input: scheme === "total_control" ? "R2" : "Cross", behavior: "hold" },
    ],
    timingCue: "Match gap before the blue line",
    verificationStatus: "verified",
    verifiedAt: new Date().toISOString(),
    sourceConfidence: "high",
    platformComparison: false,
  };
}

function guidanceFor(platform: SupportedPlatform, scheme: string): ControlGuidance {
  if (platform.startsWith("playstation")) return playstationGuidance(scheme);
  return xboxGuidance(scheme);
}

function buildObservations(job: SimulatorJob): ScottyObservation[] {
  const n = observationCount(job);
  const duration = job.mediaDurationSec;
  const categories = [
    "positioning",
    "decision_making",
    "defense",
    "offense",
    "transition",
    "puck_management",
  ] as const;
  const out: ScottyObservation[] = [];
  for (let i = 0; i < n; i++) {
    const ts = clampTs(((i + 1) / (n + 1)) * duration, duration);
    out.push({
      timestampSec: ts,
      category: categories[i % categories.length]!,
      observedAction: `Simulated observation ${i + 1} at ${ts.toFixed(1)}s`,
      attributionExplanation: `Tracked controlled player (${job.effectivePlayer.position}) via ${job.effectivePlayer.source}`,
      coachingInterpretation: "Maintain spacing and support angles through the next transition.",
      confidence: "moderate",
      recommendedMechanic: i % 2 === 0 ? "gap_control" : "puck_support",
    });
  }
  // Validate all timestamps within duration.
  for (const o of out) {
    if (o.timestampSec !== undefined && o.timestampSec > duration) {
      throw new Error("INVALID_TIMESTAMP_FIXTURE");
    }
  }
  return out;
}

function buildDrills(job: SimulatorJob): PracticeDrill[] {
  const platform = job.submission.playerContext.platform;
  const scheme = job.submission.playerContext.controlScheme;
  const title = job.submission.gameContext.selectedGameTitle;
  const position = job.effectivePlayer.position;
  const input = platform.startsWith("playstation")
    ? [
        { order: 0, input: "Left Stick", behavior: "motion" as const },
        { order: 1, input: "Cross", behavior: "tap" as const },
      ]
    : [
        { order: 0, input: "LS", behavior: "motion" as const },
        { order: 1, input: "A", behavior: "tap" as const },
      ];
  return [
    {
      drillId: "sim-drill-gap",
      name: "Gap control reps",
      objective: "Hold a tight gap at the blue line",
      gameTitle: title,
      platform,
      controlScheme: scheme,
      position,
      setup: "Offline 3v3 practice",
      requiredMechanics: ["gap_control"],
      verifiedControlInputs: input,
      repetitionTarget: "10 clean gaps",
      successCriteria: "Force dump-ins 7/10",
      commonErrors: ["Over-committing"],
      progression: "Add a trailing F2 after five reps",
    },
    {
      drillId: "sim-drill-support",
      name: "Puck support angles",
      objective: "Present a support option below the puck",
      gameTitle: title,
      platform,
      controlScheme: scheme,
      position,
      setup: "Small-area 2v2",
      requiredMechanics: ["puck_support"],
      verifiedControlInputs: input,
      repetitionTarget: "8 support catches",
      successCriteria: "Receive and face play up-ice",
      commonErrors: ["Standing still in the slot"],
    },
    {
      drillId: "sim-drill-transition",
      name: "Neutral-zone exits",
      objective: "Exit with speed through the middle lane",
      gameTitle: title,
      platform,
      controlScheme: scheme,
      position,
      setup: "Breakout vs 1-2-2",
      requiredMechanics: ["transition"],
      verifiedControlInputs: input,
      repetitionTarget: "6 clean exits",
      successCriteria: "Gain the red line with possession",
      commonErrors: ["Forced rim under no pressure"],
    },
  ].slice(0, 3);
}

export function buildSimulatorReport(input: {
  job: SimulatorJob;
  now: Date;
  includeFaceoffs?: boolean;
}): ScottyReport {
  const { job, now } = input;
  const includeFaceoffs =
    input.includeFaceoffs ??
    (job.scenario === "successful_full_game" || job.mediaClassification === "full_game");

  const platform = job.submission.playerContext.platform;
  const scheme = job.submission.playerContext.controlScheme;
  const observations = buildObservations(job);
  const guidance = guidanceFor(platform, scheme);

  // Ensure platform purity.
  if (guidance.platform.startsWith("xbox") && platform.startsWith("playstation")) {
    throw new Error("PLATFORM_CONTROL_MIX");
  }
  if (guidance.platform.startsWith("playstation") && platform.startsWith("xbox")) {
    throw new Error("PLATFORM_CONTROL_MIX");
  }

  const faceoffCount = includeFaceoffs ? (job.mediaClassification === "full_game" ? 12 : 4) : 0;
  const wins = includeFaceoffs ? Math.floor(faceoffCount * 0.55) : 0;
  const losses = includeFaceoffs ? faceoffCount - wins : 0;

  const fixtureId = resolveReportFixtureId({
    mediaClassification: job.mediaClassification,
    platform,
    controlScheme: scheme,
    includeFaceoffs: faceoffCount > 0,
    strategyHeavy: job.mediaClassification === "full_game",
  });

  const report = scottyReportSchema.parse({
    reportId: `sim_report_${fixtureId}_${randomUUID().slice(0, 6)}`,
    jobId: job.externalJobId,
    uploadId: job.uploadId,
    generatedAt: now.toISOString(),
    gameContext: job.submission.gameContext,
    playerAttribution: {
      position: job.effectivePlayer.position,
      jerseyNumber: job.effectivePlayer.jerseyNumber,
      indicatorColor: job.effectivePlayer.indicatorColor,
      confirmationState: job.effectivePlayer.userConfirmed ? "confirmed" : "auto_accepted",
    },
    controlledPlayerConfidence: job.effectivePlayer.confidenceLabel,
    playerSpecificObservations: observations,
    strengths: ["Support positioning", "Puck retrieval work rate"],
    priorityImprovements: ["Gap control on entries", "Neutral-zone exits"],
    strategyAnalysis: {
      observedStrategy: includeFaceoffs ? "1-2-2 forecheck look" : "Compact defensive structure",
      strategyCategory: "forecheck",
      controlledPlayerPosition: job.effectivePlayer.position,
      playerResponsibility: "Pressure the strong-side D",
      executionAssessment: "Arrived on time in sampled frames",
      strategicStrengths: ["F1 pressure"],
      strategicImprovements: ["Weak-side support"],
      knownCounters: [],
      requiredMechanics: ["gap_control"],
      confidence: "moderate",
      supportingTimestampsSec: observations.slice(0, 3).map((o) => o.timestampSec!).filter(Boolean),
    },
    ...(faceoffCount > 0
      ? {
          faceoffAnalysis: {
            faceoffCount,
            wins,
            losses,
            winPercentage: Math.round((wins / faceoffCount) * 1000) / 10,
            detectedTechniques: ["stance_setup"],
            strengths: ["Timing on draws"],
            improvements: ["Post-draw exit paths"],
            confidence: "moderate" as const,
          },
        }
      : {}),
    controlGuidance: [guidance],
    practiceDrills: buildDrills(job),
    uncertaintyDisclosures: ["Simulator fixture — not live Scotty analysis"],
    rubricVersion: "rubric-v1",
    strategyKnowledgeVersion: "strategy-v1",
    controlKnowledgeVersion: "controls-v1",
    reportVersion: "report-v1-sim",
    qualityValidation: {
      passed: job.scenario !== "report_validation_failure",
      issues: job.scenario === "report_validation_failure" ? ["Simulated validation failure"] : [],
      validatedAt: now.toISOString(),
    },
  });

  if (!report.qualityValidation.passed) {
    throw Object.assign(new Error("REPORT_VALIDATION_FAILED"), {
      code: "REPORT_VALIDATION_FAILED",
    });
  }

  return report;
}
