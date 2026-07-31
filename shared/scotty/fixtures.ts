/** Deterministic fixtures for Scotty contract tests (no media bytes). */
import { SCOTTY_CONTRACT_VERSION } from "./version";
import type { PlayerContext } from "./player-context";
import type { GameContext } from "./game-context";
import type { TrustedMediaMetadata } from "./upload";
import type { ScottyReport } from "./report";
import type { ControlGuidance } from "./controls";

export const FIXED_NOW = new Date("2026-07-31T12:00:00.000Z");

export function xboxPlayerContext(overrides: Partial<PlayerContext> = {}): PlayerContext {
  return {
    platform: "xbox_series",
    controlScheme: "skill_stick",
    position: "C",
    gameMode: "eashl",
    jerseyNumber: 19,
    indicatorColor: "blue",
    teamSide: "home",
    ...overrides,
  };
}

export function playstationPlayerContext(overrides: Partial<PlayerContext> = {}): PlayerContext {
  return {
    platform: "playstation_5",
    controlScheme: "total_control",
    position: "LW",
    gameMode: "online_versus",
    jerseyNumber: 88,
    indicatorColor: "orange",
    teamSide: "away",
    ...overrides,
  };
}

export function sampleGameContext(overrides: Partial<GameContext> = {}): GameContext {
  return {
    selectedGameTitle: "NHL 25",
    canonicalGameId: "nhl-25",
    supportStatus: "supported",
    mismatchState: "none",
    gameVersion: "1.0",
    ...overrides,
  };
}

export function trustedMedia(durationSec: number): TrustedMediaMetadata {
  return {
    durationSec,
    width: 1280,
    height: 720,
    fps: 60,
    codec: "h264",
    container: "mp4",
    inspectedAt: FIXED_NOW.toISOString(),
  };
}

export function xboxControlGuidance(): ControlGuidance {
  return {
    gameTitle: "NHL 25",
    platform: "xbox_series",
    controlScheme: "skill_stick",
    canonicalMechanic: "saucer_pass",
    inputSequence: [
      { order: 0, input: "LB", behavior: "hold" },
      { order: 1, input: "A", behavior: "tap" },
    ],
    timingCue: "Release on the stick flex",
    verificationStatus: "verified",
    verifiedAt: FIXED_NOW.toISOString(),
    sourceConfidence: "high",
    platformComparison: false,
  };
}

export function minimalScottyReport(overrides: Partial<ScottyReport> = {}): ScottyReport {
  return {
    contractVersion: SCOTTY_CONTRACT_VERSION,
    reportId: "report-1",
    jobId: "job-1",
    uploadId: "upload-1",
    generatedAt: FIXED_NOW.toISOString(),
    gameContext: sampleGameContext(),
    playerAttribution: {
      position: "C",
      jerseyNumber: 19,
      indicatorColor: "blue",
      confirmationState: "confirmed",
    },
    controlledPlayerConfidence: "high",
    playerSpecificObservations: [
      {
        timestampSec: 120,
        category: "positioning",
        observedAction: "Held high slot support",
        attributionExplanation: "Blue indicator on #19 at center",
        coachingInterpretation: "Good offensive support angle",
        confidence: "moderate",
      },
    ],
    strengths: ["Support positioning"],
    priorityImprovements: ["Gap control on entries"],
    strategyAnalysis: {
      observedStrategy: "1-2-2 forecheck look",
      strategyCategory: "forecheck",
      controlledPlayerPosition: "C",
      playerResponsibility: "Pressure the strong-side D",
      executionAssessment: "Arrived on time in sampled frames",
      strategicStrengths: ["F1 pressure"],
      strategicImprovements: ["Weak-side support"],
      knownCounters: [],
      requiredMechanics: ["gap_control"],
      confidence: "moderate",
      supportingTimestampsSec: [120],
    },
    controlGuidance: [xboxControlGuidance()],
    practiceDrills: [
      {
        drillId: "drill-1",
        name: "Gap control reps",
        objective: "Hold a tight gap at the blue line",
        gameTitle: "NHL 25",
        platform: "xbox_series",
        controlScheme: "skill_stick",
        position: "C",
        setup: "Offline 3v3 practice",
        requiredMechanics: ["gap_control"],
        verifiedControlInputs: [{ order: 0, input: "LS", behavior: "motion" }],
        repetitionTarget: "10 clean gaps",
        successCriteria: "Force dump-ins 7/10",
        commonErrors: ["Over-committing"],
      },
    ],
    uncertaintyDisclosures: ["Events between sampled frames are unavailable"],
    rubricVersion: "rubric-v1",
    strategyKnowledgeVersion: "strategy-v1",
    controlKnowledgeVersion: "controls-v1",
    reportVersion: "report-v1",
    qualityValidation: {
      passed: true,
      issues: [],
      validatedAt: FIXED_NOW.toISOString(),
    },
    ...overrides,
  };
}
