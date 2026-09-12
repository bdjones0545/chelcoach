/**
 * Turn a model analysis into a contract-valid Scotty report.
 *
 * The model only ever produces the analysis pieces (observations, strategy, drills, disclosures)
 * keyed by frame index and mechanic id. This module resolves frame indices to real timestamps,
 * attaches verified control inputs, enforces every bound in the report contract, and records a
 * quality validation result. Anything the model referenced that does not exist (an unknown
 * mechanic, a frame index out of range) is dropped and disclosed rather than guessed at.
 */
import { randomUUID } from "node:crypto";
import type { GameplayAnalysisModelOutput } from "../../ai/modelClient";
import {
  scottyReportSchema,
  type ControlGuidance,
  type PracticeDrill,
  type ScottyAnalysisSubmission,
  type ScottyReport,
} from "../../scottyContract";
import {
  CONTROL_KNOWLEDGE_VERSION,
  REPORT_VERSION,
  RUBRIC_VERSION,
  STRATEGY_KNOWLEDGE_VERSION,
  controlGuidanceFor,
  drillInputsFor,
  isKnownMechanic,
} from "./controlsKnowledge";

const MAX_OBSERVATIONS = 40;
const MAX_LIST = 10;
const MAX_DISCLOSURES = 20;
const MAX_DRILLS = 3;
const MAX_GUIDANCE = 10;

function clip(text: string | null | undefined, max: number): string {
  const t = (text ?? "").replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  return `${t.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

function clipList(items: string[] | undefined, maxItems: number, maxLen: number): string[] {
  return (items ?? [])
    .map((s) => clip(s, maxLen))
    .filter((s) => s.length > 0)
    .slice(0, maxItems);
}

export interface AssembleReportInput {
  externalJobId: string;
  submission: ScottyAnalysisSubmission;
  frameTimestampsSec: number[];
  output: GameplayAnalysisModelOutput;
  now: Date;
}

export interface AssembledReport {
  report: ScottyReport;
  issues: string[];
}

/**
 * Assemble and validate. Throws a plain Error with code REPORT_VALIDATION_FAILED when the result
 * cannot satisfy the contract even after bounding (for example zero usable observations).
 */
export function assembleScottyReport(input: AssembleReportInput): AssembledReport {
  const { submission, output, frameTimestampsSec } = input;
  const nowIso = input.now.toISOString();
  const issues: string[] = [];
  const durationSec = submission.mediaMetadata.durationSec;
  const platform = submission.playerContext.platform;
  const controlScheme = submission.playerContext.controlScheme;
  const gameTitle = submission.gameContext.selectedGameTitle;
  const gameVersion = submission.gameContext.gameVersion;

  const tsFor = (frameIndex: number): number | null => {
    const ts = frameTimestampsSec[Math.trunc(frameIndex)];
    if (ts === undefined) return null;
    return Math.min(Math.max(0, ts), Math.min(1800, durationSec));
  };

  let droppedObservations = 0;
  const observations = output.observations
    .map((o) => {
      const ts = tsFor(o.frameIndex);
      if (ts === null) {
        droppedObservations += 1;
        return null;
      }
      const mechanic = isKnownMechanic(o.recommendedMechanic) ? o.recommendedMechanic : undefined;
      return {
        timestampSec: ts,
        category: o.category,
        observedAction: clip(o.observedAction, 400),
        attributionExplanation: clip(o.attributionExplanation, 400),
        coachingInterpretation: clip(o.coachingInterpretation, 600),
        confidence: o.confidence,
        ...(mechanic ? { recommendedMechanic: mechanic } : {}),
      };
    })
    .filter((o): o is NonNullable<typeof o> => o !== null && o.observedAction.length > 0)
    .slice(0, MAX_OBSERVATIONS);
  if (droppedObservations > 0) issues.push(`${droppedObservations} observation(s) referenced a frame that was not sampled`);
  if (observations.length === 0) {
    throw Object.assign(new Error("REPORT_VALIDATION_FAILED"), {
      code: "REPORT_VALIDATION_FAILED",
      detail: "no usable observations",
    });
  }

  const s = output.strategyAnalysis;
  const supportingTimestampsSec = [...new Set(s.supportingFrameIndices.map(tsFor).filter((t): t is number => t !== null))].slice(0, 20);
  const strategyMechanics = s.requiredMechanics.filter(isKnownMechanic).slice(0, 20);
  const unknownStrategyMechanics = s.requiredMechanics.length - strategyMechanics.length;
  if (unknownStrategyMechanics > 0) issues.push(`${unknownStrategyMechanics} unknown mechanic id(s) dropped from strategy analysis`);

  const strategyAnalysis = {
    observedStrategy: clip(s.observedStrategy, 160) || "Insufficient evidence",
    strategyCategory: s.strategyCategory,
    controlledPlayerPosition: submission.effectivePlayer.position,
    playerResponsibility: clip(s.playerResponsibility, 400),
    executionAssessment: clip(s.executionAssessment, 600),
    strategicStrengths: clipList(s.strategicStrengths, MAX_LIST, 200),
    strategicImprovements: clipList(s.strategicImprovements, MAX_LIST, 200),
    ...(s.recommendedAdjustment ? { recommendedAdjustment: clip(s.recommendedAdjustment, 400) } : {}),
    knownCounters: clipList(s.knownCounters, MAX_LIST, 200),
    requiredMechanics: strategyMechanics,
    confidence: s.confidence,
    supportingTimestampsSec,
  };

  let faceoffAnalysis: ScottyReport["faceoffAnalysis"];
  const f = output.faceoffAnalysis;
  if (f && Number.isFinite(f.faceoffCount) && f.faceoffCount > 0) {
    const faceoffCount = Math.min(200, Math.max(0, Math.trunc(f.faceoffCount)));
    let wins = Math.min(200, Math.max(0, Math.trunc(f.wins)));
    let losses = Math.min(200, Math.max(0, Math.trunc(f.losses)));
    if (wins + losses > faceoffCount) {
      issues.push("faceoff wins + losses exceeded the visible faceoff count; clamped");
      losses = Math.max(0, faceoffCount - wins);
      wins = Math.min(wins, faceoffCount);
    }
    faceoffAnalysis = {
      faceoffCount,
      wins,
      losses,
      winPercentage: faceoffCount > 0 ? Math.round((wins / faceoffCount) * 1000) / 10 : undefined,
      detectedTechniques: clipList(f.detectedTechniques, 20, 120),
      ...(f.timingAssessment ? { timingAssessment: clip(f.timingAssessment, 400) } : {}),
      ...(f.counterSelection ? { counterSelection: clip(f.counterSelection, 400) } : {}),
      ...(f.postDrawResponsibility ? { postDrawResponsibility: clip(f.postDrawResponsibility, 400) } : {}),
      ...(f.possessionResult ? { possessionResult: clip(f.possessionResult, 400) } : {}),
      strengths: clipList(f.strengths, MAX_LIST, 200),
      improvements: clipList(f.improvements, MAX_LIST, 200),
      confidence: f.confidence,
    };
  }

  // Control guidance: every mechanic the report leans on, on the user's platform only.
  const referenced: string[] = [];
  const pushMechanic = (id: string | undefined) => {
    if (id && isKnownMechanic(id) && !referenced.includes(id)) referenced.push(id);
  };
  for (const o of observations) pushMechanic(o.recommendedMechanic);
  for (const id of strategyMechanics) pushMechanic(id);
  const drillsRaw = output.practiceDrills.slice(0, MAX_DRILLS);
  for (const d of drillsRaw) for (const id of d.requiredMechanics) pushMechanic(isKnownMechanic(id) ? id : undefined);

  const controlGuidance: ControlGuidance[] = [];
  for (const id of referenced) {
    if (controlGuidance.length >= MAX_GUIDANCE) break;
    const g = controlGuidanceFor({ mechanicId: id, gameTitle, gameVersion, platform, controlScheme, verifiedAt: nowIso });
    if (g) controlGuidance.push(g);
  }
  const provisional = controlGuidance.filter((g) => g.verificationStatus !== "verified").length;

  const practiceDrills: PracticeDrill[] = drillsRaw
    .map((d, i) => {
      const mechanics = d.requiredMechanics.filter(isKnownMechanic).slice(0, 20);
      return {
        drillId: `drill-${i + 1}`,
        name: clip(d.name, 120) || `Practice drill ${i + 1}`,
        objective: clip(d.objective, 400) || "Reinforce the priority improvement",
        gameTitle,
        platform: platform as PracticeDrill["platform"],
        controlScheme: controlScheme as PracticeDrill["controlScheme"],
        position: submission.effectivePlayer.position,
        setup: clip(d.setup, 500),
        requiredMechanics: mechanics,
        verifiedControlInputs: drillInputsFor(mechanics, platform),
        repetitionTarget: clip(d.repetitionTarget, 120),
        successCriteria: clip(d.successCriteria, 300),
        commonErrors: clipList(d.commonErrors, MAX_LIST, 200),
        ...(d.progression ? { progression: clip(d.progression, 400) } : {}),
      };
    })
    .filter((d) => d.name.length > 0);

  const disclosures = clipList(output.uncertaintyDisclosures, MAX_DISCLOSURES - 2, 300);
  disclosures.push(
    clip(
      `Analysis is based on ${frameTimestampsSec.length} frames sampled at fixed intervals; events between samples are not visible.`,
      300,
    ),
  );
  if (provisional > 0) {
    disclosures.push(
      clip(
        `${provisional} control input${provisional === 1 ? "" : "s"} are marked provisional — confirm against your in-game controller settings.`,
        300,
      ),
    );
  }

  const candidate = {
    contractVersion: submission.contractVersion,
    reportId: `rpt_${randomUUID()}`,
    jobId: input.externalJobId,
    uploadId: submission.uploadId,
    generatedAt: nowIso,
    gameContext: submission.gameContext,
    playerAttribution: {
      position: submission.effectivePlayer.position,
      jerseyNumber: submission.effectivePlayer.jerseyNumber,
      indicatorColor: submission.effectivePlayer.indicatorColor,
      confirmationState: submission.effectivePlayer.userConfirmed ? ("confirmed" as const) : ("auto_accepted" as const),
    },
    controlledPlayerConfidence: output.controlledPlayerConfidence,
    playerSpecificObservations: observations,
    strengths: clipList(output.strengths, MAX_LIST, 240),
    priorityImprovements: clipList(output.priorityImprovements, MAX_LIST, 240),
    strategyAnalysis,
    ...(faceoffAnalysis ? { faceoffAnalysis } : {}),
    controlGuidance,
    practiceDrills,
    uncertaintyDisclosures: disclosures.slice(0, MAX_DISCLOSURES),
    rubricVersion: RUBRIC_VERSION,
    strategyKnowledgeVersion: STRATEGY_KNOWLEDGE_VERSION,
    controlKnowledgeVersion: CONTROL_KNOWLEDGE_VERSION,
    reportVersion: REPORT_VERSION,
    qualityValidation: {
      passed: issues.length === 0,
      issues: issues.map((i) => clip(i, 200)).slice(0, 20),
      validatedAt: nowIso,
    },
  };

  const parsed = scottyReportSchema.safeParse(candidate);
  if (!parsed.success) {
    throw Object.assign(new Error("REPORT_VALIDATION_FAILED"), {
      code: "REPORT_VALIDATION_FAILED",
      detail: parsed.error.issues
        .slice(0, 5)
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; "),
    });
  }
  return { report: parsed.data, issues };
}
