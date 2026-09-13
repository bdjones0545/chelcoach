/**
 * Map a Scottie gateway report (its own normalized shape: scorecard / coachingMoments / filmRoom,
 * plus the controls, faceoffs and strategy sections Scottie attaches) onto ChelCoach's
 * `ScottyReport` contract, enforcing every bound the contract carries.
 *
 * Everything that has no counterpart in Scottie's output is derived conservatively and
 * disclosed; nothing is invented. Verified control inputs come from Scottie's registry
 * (`execution.verified`), never from prose.
 */
import { randomUUID } from "node:crypto";
import {
  scottyReportSchema,
  type ControlGuidance,
  type ControlInputStep,
  type EvidenceConfidenceLabel,
  type PracticeDrill,
  type ScottyAnalysisSubmission,
  type ScottyReport,
} from "../../scottyContract";

type Dict = Record<string, unknown>;

const OBSERVATION_CATEGORIES = new Set([
  "positioning",
  "decision_making",
  "puck_management",
  "defense",
  "offense",
  "transition",
  "faceoff",
  "special_teams",
  "other",
]);
const STRATEGY_CATEGORIES = new Set([
  "forecheck",
  "neutral_zone",
  "defensive_zone",
  "power_play",
  "penalty_kill",
  "breakout",
  "cycle",
  "transition",
  "unknown",
  "insufficient_evidence",
]);
const PLATFORMS = new Set(["xbox_series", "xbox_one", "playstation_5", "playstation_4", "unknown"]);
const SCHEMES = new Set(["total_control", "skill_stick", "hybrid", "goalie", "unknown"]);

function isDict(v: unknown): v is Dict {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function str(v: unknown, max: number): string {
  if (v === null || v === undefined) return "";
  const t = String(v).replace(/\s+/g, " ").trim();
  return t.length <= max ? t : `${t.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}
function strList(v: unknown, maxItems: number, maxLen: number): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const item of v) {
    const s = isDict(item) ? str(item.title ?? item.observation ?? item.recommendedAdjustment ?? item.label, maxLen) : str(item, maxLen);
    if (s && !out.includes(s)) out.push(s);
    if (out.length >= maxItems) break;
  }
  return out;
}
function num(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
}

/** "m:ss" or seconds → seconds. */
export function parseScottieTimestamp(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (/^\d+(\.\d+)?$/.test(s)) return Number(s);
  const m = /^(\d+):(\d{2})(?:\.(\d+))?$/.exec(s);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]) + (m[3] ? Number(`0.${m[3]}`) : 0);
}

export function confidenceLabel(v: unknown): EvidenceConfidenceLabel {
  if (typeof v === "string") {
    const s = v.toLowerCase();
    if (s === "official") return "official";
    if (s === "very_high") return "very_high";
    if (s === "high") return "high";
    if (s === "medium" || s === "moderate") return "moderate";
    if (s === "low") return "low";
    if (s === "conflicting") return "conflicting";
    if (s === "unverified") return "unverified";
    if (s === "insufficient") return "insufficient";
  }
  const n = num(v);
  if (n === null) return "unverified";
  const x = n > 1 ? n / 100 : n;
  if (x >= 0.9) return "very_high";
  if (x >= 0.75) return "high";
  if (x >= 0.55) return "moderate";
  if (x >= 0.35) return "low";
  return "insufficient";
}

const CATEGORY_MAP: Record<string, string> = {
  spacing: "positioning",
  positioning: "positioning",
  offensive_positioning: "offense",
  offense: "offense",
  defensive_positioning: "defense",
  defense: "defense",
  decision_making: "decision_making",
  puck_movement: "puck_management",
  puck_management: "puck_management",
  transition_play: "transition",
  transition: "transition",
  faceoff: "faceoff",
  faceoff_strategy: "faceoff",
  special_teams: "special_teams",
};
function observationCategory(v: unknown, momentType: unknown): ScottyReport["playerSpecificObservations"][number]["category"] {
  const key = String(v ?? "").toLowerCase().replace(/-/g, "_");
  const mapped = CATEGORY_MAP[key];
  if (mapped && OBSERVATION_CATEGORIES.has(mapped)) return mapped as never;
  if (momentType === "breakdown") return "defense";
  if (momentType === "missed") return "decision_making";
  return "other";
}

const STRATEGY_MAP: Record<string, string> = {
  forecheck: "forecheck",
  neutral_zone: "neutral_zone",
  nz: "neutral_zone",
  defensive_zone: "defensive_zone",
  dz: "defensive_zone",
  power_play: "power_play",
  pp: "power_play",
  penalty_kill: "penalty_kill",
  pk: "penalty_kill",
  breakout: "breakout",
  cycle: "cycle",
  transition: "transition",
  faceoff_strategy: "unknown",
  faceoff_sequence: "unknown",
};
function strategyCategory(v: unknown): ScottyReport["strategyAnalysis"]["strategyCategory"] {
  const key = String(v ?? "").toLowerCase().replace(/[\s-]/g, "_");
  const mapped = STRATEGY_MAP[key];
  return (mapped && STRATEGY_CATEGORIES.has(mapped) ? mapped : "unknown") as never;
}

function behavior(v: unknown): ControlInputStep["behavior"] {
  const s = String(v ?? "").toLowerCase();
  if (s === "tap" || s === "press" || s === "release") return "tap";
  if (s === "hold" || s === "modifier") return "hold";
  if (s === "motion") return "motion";
  if (s === "combo") return "combo";
  return "unknown";
}

function inputSteps(v: unknown, max = 40): ControlInputStep[] {
  if (!Array.isArray(v)) return [];
  const out: ControlInputStep[] = [];
  for (const raw of v) {
    if (!isDict(raw)) continue;
    const input = str(raw.input, 80);
    if (!input) continue;
    const note = str(raw.note ?? raw.timing, 200);
    out.push({ order: out.length, input, behavior: behavior(raw.behavior), ...(note ? { note } : {}) });
    if (out.length >= max) break;
  }
  return out;
}

export interface MapScottieReportInput {
  externalJobId: string;
  submission: ScottyAnalysisSubmission;
  report: Dict;
  controlledPlayer?: Dict;
  providerMetadata?: Dict;
  frameTimestampsSec: number[];
  now: Date;
}

export function mapScottieReport(input: MapScottieReportInput): { report: ScottyReport; issues: string[] } {
  const { submission, report, frameTimestampsSec } = input;
  const issues: string[] = [];
  const nowIso = input.now.toISOString();
  const durationSec = submission.mediaMetadata.durationSec;
  const platform = submission.playerContext.platform;
  const scheme = submission.playerContext.controlScheme;
  const gameTitle = submission.gameContext.selectedGameTitle;
  const e = submission.effectivePlayer;
  const clampTs = (t: number) => Math.min(Math.max(0, t), Math.min(1800, durationSec));
  const attributionDefault = `Attributed to the controlled skater (indicator ${e.indicatorColor ?? "unknown"}, jersey ${e.jerseyNumber ?? "unknown"}, ${e.position})`;

  // --- observations from coaching moments -------------------------------------------------
  const moments = Array.isArray(report.coachingMoments) ? report.coachingMoments.filter(isDict) : [];
  const guidance: ControlGuidance[] = [];
  const pushGuidance = (ex: unknown) => {
    if (!isDict(ex) || ex.executionAvailable !== true) return;
    const p = String(ex.platform ?? platform);
    const s = String(ex.controlScheme ?? scheme);
    const steps = inputSteps(ex.inputs);
    const mechanic = str(ex.mechanic, 120);
    if (!steps.length || !mechanic) return;
    if (guidance.length >= 10 || guidance.some((g) => g.canonicalMechanic === mechanic)) return;
    if (!PLATFORMS.has(p) || p !== platform) {
      issues.push(`control guidance for ${mechanic} was for platform ${p}, not the user's ${platform}`);
      return;
    }
    const verified = ex.verified === true;
    guidance.push({
      gameTitle: str(ex.gameTitle, 120) || gameTitle,
      platform: p as ControlGuidance["platform"],
      controlScheme: (SCHEMES.has(s) ? s : scheme) as ControlGuidance["controlScheme"],
      canonicalMechanic: mechanic,
      inputSequence: steps,
      ...(str(ex.timingCue, 300) ? { timingCue: str(ex.timingCue, 300) } : {}),
      verificationStatus: verified ? "verified" : "provisional",
      ...(verified ? { verifiedAt: nowIso } : {}),
      sourceConfidence: confidenceLabel(ex.sourceConfidence ?? (verified ? "high" : "low")),
      platformComparison: false,
    });
  };

  const observations = moments
    .map((m) => {
      const ts = parseScottieTimestamp(m.timestampSeconds ?? m.timestamp);
      if (ts === null || ts > durationSec + 5) {
        issues.push("a coaching moment had no usable timestamp within the clip and was dropped");
        return null;
      }
      pushGuidance(m.execution);
      const execution = isDict(m.execution) && m.execution.executionAvailable === true ? str(m.execution.mechanic, 160) : "";
      return {
        timestampSec: clampTs(ts),
        category: observationCategory(m.coachingCategory ?? m.category, m.type),
        observedAction: str(m.observedAction ?? m.title, 400) || "Observed play",
        attributionExplanation: str(m.attributionReason, 400) || attributionDefault,
        coachingInterpretation: str(m.fullBreakdown ?? m.detail ?? m.teaser, 600) || str(m.title, 600),
        confidence: confidenceLabel(m.attributionConfidence ?? m.confidence ?? report.confidence),
        ...(execution ? { recommendedMechanic: execution } : {}),
      };
    })
    .filter((o): o is NonNullable<typeof o> => o !== null && o.coachingInterpretation.length > 0)
    .slice(0, 40);
  if (observations.length === 0) {
    throw Object.assign(new Error("REPORT_VALIDATION_FAILED"), {
      code: "REPORT_VALIDATION_FAILED",
      detail: "Scottie report carried no usable coaching moments",
    });
  }

  // --- strengths / improvements ------------------------------------------------------------
  const scorecard = isDict(report.scorecard) ? report.scorecard : {};
  const filmRoom = isDict(report.filmRoom) ? report.filmRoom : {};
  const strengths = [
    ...(isDict(scorecard.biggestStrength) ? [str(scorecard.biggestStrength.title, 240)] : []),
    ...strList(filmRoom.strengths, 10, 240),
  ].filter((s, i, arr) => s && arr.indexOf(s) === i).slice(0, 10);
  const improvements = [
    ...(isDict(filmRoom.highestImpactAdjustment) ? [str(filmRoom.highestImpactAdjustment.title, 240)] : []),
    ...(isDict(scorecard.biggestWeakness) ? [str(scorecard.biggestWeakness.title, 240)] : []),
    ...strList(filmRoom.mistakes, 10, 240),
    ...(str(filmRoom.nextGameFocus, 240) ? [str(filmRoom.nextGameFocus, 240)] : []),
  ].filter((s, i, arr) => s && arr.indexOf(s) === i).slice(0, 10);

  // --- strategy -----------------------------------------------------------------------------
  const sa = isDict(report.strategyAnalysis) ? report.strategyAnalysis : null;
  const improvementsRaw = sa && Array.isArray(sa.improvements) ? sa.improvements.filter(isDict) : [];
  const recommended = sa && isDict(sa.recommendedStrategy) ? sa.recommendedStrategy : null;
  if (sa && Array.isArray(sa.executionControls)) for (const ex of sa.executionControls) pushGuidance(ex);
  const strategyMechanics = strList(improvementsRaw[0]?.requiredMechanics ?? recommended?.requiredMechanics ?? recommended?.required_mechanics, 20, 120);
  const strategyAnalysis: ScottyReport["strategyAnalysis"] = sa
    ? {
        observedStrategy: str(sa.observedSystem ?? recommended?.strategyName ?? recommended?.strategy_name, 160) || "Observed team pattern",
        strategyCategory: strategyCategory(improvementsRaw[0]?.strategyCategory ?? recommended?.category ?? sa.classification),
        controlledPlayerPosition: e.position,
        playerResponsibility: str(sa.playerResponsibility, 400),
        executionAssessment: str(
          num(sa.executionGrade) !== null
            ? `Execution graded ${Math.round(num(sa.executionGrade)!)}/100 from the sampled frames.${str(sa.note, 400) ? ` ${str(sa.note, 400)}` : ""}`
            : (sa.note ?? filmRoom.commentary),
          600,
        ),
        strategicStrengths: strList(sa.strengths, 10, 200),
        strategicImprovements: improvementsRaw
          .map((i) => str(i.recommendedAdjustment ?? i.observation, 200))
          .filter(Boolean)
          .slice(0, 10),
        ...(str(improvementsRaw[0]?.recommendedAdjustment, 400) ? { recommendedAdjustment: str(improvementsRaw[0]?.recommendedAdjustment, 400) } : {}),
        knownCounters: strList(sa.knownCounters, 10, 200),
        requiredMechanics: strategyMechanics,
        confidence: confidenceLabel(sa.evidenceConfidence),
        supportingTimestampsSec: [...new Set(observations.map((o) => o.timestampSec))].slice(0, 20),
      }
    : {
        observedStrategy: "Insufficient evidence for a team system",
        strategyCategory: "insufficient_evidence",
        controlledPlayerPosition: e.position,
        playerResponsibility: "",
        executionAssessment: str(filmRoom.commentary, 600),
        strategicStrengths: [],
        strategicImprovements: [],
        knownCounters: [],
        requiredMechanics: [],
        confidence: "insufficient",
        supportingTimestampsSec: [],
      };
  if (!sa) issues.push("Scottie attached no strategy section; strategy marked insufficient_evidence");

  // --- faceoffs -----------------------------------------------------------------------------
  let faceoffAnalysis: ScottyReport["faceoffAnalysis"];
  const fo = isDict(report.faceoffs) ? report.faceoffs : null;
  if (fo && fo.applicable === true && (num(fo.drawsAnalyzed) ?? 0) > 0) {
    const count = Math.min(200, Math.max(0, Math.trunc(num(fo.drawsAnalyzed) ?? 0)));
    let wins = Math.min(200, Math.max(0, Math.trunc(num(fo.wins) ?? 0)));
    let losses = Math.min(200, Math.max(0, Math.trunc(num(fo.losses) ?? 0)));
    if (wins + losses > count) {
      issues.push("faceoff wins + losses exceeded draws analyzed; clamped");
      wins = Math.min(wins, count);
      losses = Math.max(0, count - wins);
    }
    const pctRaw = num(fo.winPct);
    const winPercentage = pctRaw === null ? Math.round((wins / count) * 1000) / 10 : pctRaw <= 1 ? Math.round(pctRaw * 1000) / 10 : Math.min(100, pctRaw);
    const events = Array.isArray(fo.events) ? fo.events.filter(isDict) : [];
    const techniques = [...new Set(events.map((ev) => str(ev.counter_used ?? ev.win_direction, 120)).filter(Boolean))].slice(0, 20);
    faceoffAnalysis = {
      faceoffCount: count,
      wins,
      losses,
      winPercentage,
      detectedTechniques: techniques,
      ...(str(fo.timingConsistency !== undefined ? `Timing consistency ${fo.timingConsistency}` : "", 400) ? { timingAssessment: str(`Timing consistency ${fo.timingConsistency}`, 400) } : {}),
      ...(str(fo.scoringChancesNote, 400) ? { possessionResult: str(fo.scoringChancesNote, 400) } : {}),
      ...(str(fo.defensiveRecoveriesNote, 400) ? { postDrawResponsibility: str(fo.defensiveRecoveriesNote, 400) } : {}),
      strengths: [],
      improvements: strList(fo.improvementPriorities, 10, 200),
      confidence: confidenceLabel(fo.executionQuality ?? "low"),
    };
  }

  // --- drills ---------------------------------------------------------------------------------
  const drillSources: Dict[] = [];
  if (Array.isArray(report.practiceDrills)) drillSources.push(...report.practiceDrills.filter(isDict));
  if (sa && isDict(sa.practiceDrill)) drillSources.push(sa.practiceDrill);
  const practiceDrills: PracticeDrill[] = drillSources.slice(0, 3).map((d, i) => {
    const p = String(d.platform ?? platform);
    const s = String(d.controlScheme ?? scheme);
    const reps = num(d.repetitions);
    return {
      drillId: `drill-${i + 1}`,
      name: str(d.drillName ?? d.name, 120) || `Practice drill ${i + 1}`,
      objective: str(d.objective, 400) || "Reinforce the priority improvement",
      gameTitle: str(d.gameTitle, 120) || gameTitle,
      platform: (PLATFORMS.has(p) ? p : platform) as PracticeDrill["platform"],
      controlScheme: (SCHEMES.has(s) ? s : scheme) as PracticeDrill["controlScheme"],
      position: e.position,
      setup: str(d.setup ?? d.startingPosition, 500),
      requiredMechanics: strList(d.requiredMechanics, 20, 120),
      verifiedControlInputs: inputSteps(d.controls),
      repetitionTarget: str(d.repetitionTarget ?? (reps !== null ? `${Math.round(reps)} reps` : ""), 120),
      successCriteria: str(d.successCriteria ?? d.successCondition, 300),
      commonErrors: strList(d.commonErrors ?? (d.commonMistake ? [d.commonMistake] : []), 10, 200),
      ...(str(d.progression, 400) ? { progression: str(d.progression, 400) } : {}),
    };
  });

  // --- disclosures ----------------------------------------------------------------------------
  const cp = input.controlledPlayer ?? (isDict(report.playerAttribution) ? report.playerAttribution : {});
  const disclosures = [
    ...strList(cp.uncertainties, 8, 300),
    `Analysis by Scottie from ${frameTimestampsSec.length} frames sampled at fixed intervals; events between samples are not visible.`,
  ];
  const model = str(input.providerMetadata?.model, 120);
  if (model) disclosures.push(`Model: ${model}.`);
  const provisional = guidance.filter((g) => g.verificationStatus !== "verified").length;
  if (provisional > 0) disclosures.push(`${provisional} control input${provisional === 1 ? "" : "s"} are provisional — confirm against your in-game settings.`);

  const candidate = {
    contractVersion: submission.contractVersion,
    reportId: `rpt_${randomUUID()}`,
    jobId: input.externalJobId,
    uploadId: submission.uploadId,
    generatedAt: nowIso,
    gameContext: submission.gameContext,
    playerAttribution: {
      position: e.position,
      jerseyNumber: e.jerseyNumber,
      indicatorColor: e.indicatorColor,
      confirmationState: e.userConfirmed ? ("confirmed" as const) : ("auto_accepted" as const),
    },
    controlledPlayerConfidence: confidenceLabel(cp.confidence ?? e.confidence),
    playerSpecificObservations: observations,
    strengths,
    priorityImprovements: improvements,
    strategyAnalysis,
    ...(faceoffAnalysis ? { faceoffAnalysis } : {}),
    controlGuidance: guidance,
    practiceDrills,
    uncertaintyDisclosures: disclosures.slice(0, 20),
    rubricVersion: str(report.rubricVersion, 64) || "chelcoach-rubric-v1",
    strategyKnowledgeVersion: sa && str(sa.strategyId, 64) ? "scottie-strategy-registry" : "none",
    controlKnowledgeVersion: guidance.length ? "scottie-controls-registry" : "none",
    reportVersion: "scottie-remote-v1",
    qualityValidation: { passed: issues.length === 0, issues: issues.map((i) => str(i, 200)).slice(0, 20), validatedAt: nowIso },
  };

  const parsed = scottyReportSchema.safeParse(candidate);
  if (!parsed.success) {
    // Control guidance is the one section with cross-field refinements (pad mixing); drop the
    // offending entries and re-validate before giving up.
    const badGuidance = parsed.error.issues.filter((i) => i.path[0] === "controlGuidance");
    if (badGuidance.length) {
      const badIdx = new Set(badGuidance.map((i) => Number(i.path[1])));
      candidate.controlGuidance = guidance.filter((_, i) => !badIdx.has(i));
      issues.push(`${badIdx.size} control guidance entr${badIdx.size === 1 ? "y" : "ies"} failed platform validation and were dropped`);
      candidate.qualityValidation = { passed: false, issues: issues.map((i) => str(i, 200)).slice(0, 20), validatedAt: nowIso };
      const again = scottyReportSchema.safeParse(candidate);
      if (again.success) return { report: again.data, issues };
    }
    throw Object.assign(new Error("REPORT_VALIDATION_FAILED"), {
      code: "REPORT_VALIDATION_FAILED",
      detail: parsed.error.issues.slice(0, 5).map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
    });
  }
  return { report: parsed.data, issues };
}
