/**
 * Presentation adapter: ScottyReport → CoachingReportView (Step 8).
 * Organizes, groups, and labels — never invents observations, scores, or controls.
 */
import type { AnalysisReportResponse } from "../../shared/scotty/report-envelope";
import type { ScottyObservation, ScottyReport } from "../../shared/scotty/report";
import type { ControlGuidance } from "../../shared/scotty/controls";
import type { FaceoffAnalysis } from "../../shared/scotty/faceoffs";
import type { PracticeDrill } from "../../shared/scotty/drills";
import type { StrategyAnalysis } from "../../shared/scotty/strategies";
import type { PlayerPosition, SupportedPlatform, ControlScheme } from "../../shared/scotty/enums";
import { confidenceDisplayLabel } from "./reportScoreLabels";

export type ReportNavSectionId =
  | "overview"
  | "scorecard"
  | "strengths"
  | "improvements"
  | "moments"
  | "strategy"
  | "position"
  | "controls"
  | "faceoffs"
  | "practice"
  | "next"
  | "about";

export type EvidenceSeverity = "good_decision" | "improvement_opportunity" | "key_mistake" | "neutral";

export type MomentFilterCategory =
  | "all"
  | "offense"
  | "defense"
  | "transition"
  | "positioning"
  | "controls"
  | "faceoffs"
  | "strategy";

export type DrillCompletionState = "not_started" | "in_progress" | "completed";

export type CoachingMomentView = {
  id: string;
  timestampSec: number | null;
  category: string;
  filterCategory: MomentFilterCategory;
  observedAction: string;
  why: string;
  takeaway: string;
  confidenceLabel: string;
  severity: EvidenceSeverity;
  severityLabel: string;
  recommendedMechanic?: string;
};

export type StrengthCard = {
  id: string;
  title: string;
  explanation: string;
  whyItMatters: string;
  repeatThis: string;
  evidenceMomentIds: string[];
};

export type PriorityCard = {
  id: string;
  rank: number;
  issue: string;
  whyItMatters: string;
  evidenceSummary: string;
  correction: string;
  mechanic?: string;
  linkedDrillId?: string;
};

export type FocusAreaCard = {
  id: string;
  name: string;
  evidenceCount: number;
  qualitativeLabel: string;
  interpretation: string;
};

export type StrategySectionView = {
  id: string;
  title: string;
  observedPattern: string;
  impact: string;
  recommendedAdjustment: string;
  cue: string;
  evidenceTimestamps: number[];
  confidenceLabel: string;
};

export type PositionCoachingView = {
  title: string;
  position: PlayerPosition;
  themes: { title: string; detail: string }[];
};

export type ControlMechanicView = {
  id: string;
  mechanicName: string;
  platform: SupportedPlatform;
  controlScheme: ControlScheme;
  inputSequenceLabel: string;
  inputSequenceAria: string;
  steps: { order: number; input: string; behavior: string }[];
  whenToUse?: string;
  correctionCue?: string;
  verificationStatus: string;
  hasVerifiedInputs: boolean;
};

export type FaceoffView = {
  faceoffCount: number;
  wins: number;
  losses: number;
  winRateLabel: string | null;
  commonSetup: string;
  failurePattern: string;
  timingIssue?: string;
  counterRecommendation?: string;
  drillId?: string;
  confidenceLabel: string;
};

export type PracticeDrillView = {
  drill: PracticeDrill;
  whySelected: string;
  linkedPriorityId?: string;
  controlLabel: string;
};

export type NextGameFocusView = {
  primaryFocus: string;
  supportingCue: string;
  successCondition: string;
};

export type CoachingReportView = {
  applicationRequestId: string;
  uploadId: string;
  report: ScottyReport;
  header: {
    title: string;
    subtitle: string;
    gameTitle: string;
    gameMode?: string;
    position: string;
    platform: string;
    controlScheme: string;
    mediaClassification?: string;
    analysisDate: string;
    videoDurationLabel: string | null;
    confirmationSource: string;
    simulatorMode: boolean;
  };
  sourceMedia: {
    available: boolean;
    expiresAt: string | null;
    notice: string;
  };
  executive: {
    overallAssessment: string;
    performanceSummary: string;
    strongestArea: string;
    highestPriority: string;
    nextSessionObjective: string;
  };
  /** Numeric overall score — omitted when the contract has none. */
  overallScore: null;
  focusAreas: FocusAreaCard[];
  strengths: StrengthCard[];
  priorities: PriorityCard[];
  initialPriorityCount: number;
  moments: CoachingMomentView[];
  momentFilterCategories: MomentFilterCategory[];
  strategySections: StrategySectionView[];
  positionCoaching: PositionCoachingView | null;
  controls: ControlMechanicView[];
  faceoffs: FaceoffView | null;
  practiceDrills: PracticeDrillView[];
  nextGameFocus: NextGameFocusView;
  navigation: { id: ReportNavSectionId; label: string }[];
  limitations: string[];
  metadata: {
    reportVersion: string;
    rubricVersion: string;
    strategyKnowledgeVersion: string;
    controlKnowledgeVersion: string;
    generatedAt: string;
    qualityPassed: boolean;
    qualityIssues: string[];
  };
};

const INITIAL_PRIORITY_COUNT = 3;

const CATEGORY_TO_FILTER: Record<string, MomentFilterCategory> = {
  offense: "offense",
  defense: "defense",
  transition: "transition",
  positioning: "positioning",
  decision_making: "strategy",
  puck_management: "controls",
  faceoff: "faceoffs",
  special_teams: "strategy",
  other: "all",
};

const FILTER_LABELS: Record<MomentFilterCategory, string> = {
  all: "All",
  offense: "Offense",
  defense: "Defense",
  transition: "Transition",
  positioning: "Positioning",
  controls: "Controls",
  faceoffs: "Faceoffs",
  strategy: "Strategy",
};

export function momentFilterLabel(cat: MomentFilterCategory): string {
  return FILTER_LABELS[cat];
}

function platformLabel(platform?: string): string {
  switch (platform) {
    case "xbox_series":
      return "Xbox Series";
    case "xbox_one":
      return "Xbox One";
    case "playstation_5":
      return "PlayStation 5";
    case "playstation_4":
      return "PlayStation 4";
    default:
      return platform ?? "Unknown platform";
  }
}

function schemeLabel(scheme?: string): string {
  switch (scheme) {
    case "total_control":
      return "Total Control";
    case "skill_stick":
      return "Skill Stick";
    case "hybrid":
      return "Hybrid";
    case "goalie":
      return "Goalie";
    default:
      return scheme ?? "Unknown scheme";
  }
}

function positionLabel(position: PlayerPosition): string {
  const map: Record<PlayerPosition, string> = {
    C: "Center",
    LW: "Left Wing",
    RW: "Right Wing",
    LD: "Left Defense",
    RD: "Right Defense",
    G: "Goalie",
    unknown: "Unknown position",
  };
  return map[position];
}

function formatDuration(sec: number | null | undefined): string | null {
  if (sec == null || !Number.isFinite(sec) || sec <= 0) return null;
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

function formatTimestamp(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

function severityForObservation(obs: ScottyObservation, index: number, improvements: string[]): {
  severity: EvidenceSeverity;
  label: string;
} {
  const text = `${obs.observedAction} ${obs.coachingInterpretation}`.toLowerCase();
  const isStrength =
    /good|strong|clean|well|support|held|maintained|timely/.test(text) &&
    !/miss|late|forced|over-commit|gap/.test(text);
  const matchesImprovement = improvements.some((p) =>
    text.includes(p.toLowerCase().split(" ")[0] ?? ""),
  );
  if (isStrength && !matchesImprovement) {
    return { severity: "good_decision", label: "Good decision" };
  }
  if (matchesImprovement || /miss|late|forced|error|turnover/.test(text)) {
    return index % 5 === 0
      ? { severity: "key_mistake", label: "Key mistake" }
      : { severity: "improvement_opportunity", label: "Improvement opportunity" };
  }
  return { severity: "neutral", label: "Observation" };
}

function buildMoments(report: ScottyReport): CoachingMomentView[] {
  return report.playerSpecificObservations.map((obs, index) => {
    const { severity, label } = severityForObservation(obs, index, report.priorityImprovements);
    const filterCategory = CATEGORY_TO_FILTER[obs.category] ?? "all";
    return {
      id: `moment-${index}`,
      timestampSec: obs.timestampSec ?? obs.timestampRangeSec?.start ?? null,
      category: obs.category,
      filterCategory: filterCategory === "all" ? "positioning" : filterCategory,
      observedAction: obs.observedAction,
      why: obs.attributionExplanation,
      takeaway: obs.coachingInterpretation,
      confidenceLabel: confidenceDisplayLabel(obs.confidence),
      severity,
      severityLabel: label,
      recommendedMechanic: obs.recommendedMechanic,
    };
  });
}

function relatedMomentIds(moments: CoachingMomentView[], phrase: string): string[] {
  const tokens = phrase.toLowerCase().split(/\s+/).filter((t) => t.length > 3);
  return moments
    .filter((m) => {
      const hay = `${m.observedAction} ${m.takeaway} ${m.recommendedMechanic ?? ""}`.toLowerCase();
      return tokens.some((t) => hay.includes(t));
    })
    .slice(0, 3)
    .map((m) => m.id);
}

function buildStrengths(report: ScottyReport, moments: CoachingMomentView[]): StrengthCard[] {
  return report.strengths.map((title, index) => {
    const related = relatedMomentIds(moments, title);
    const relatedMoment = moments.find((m) => related.includes(m.id));
    return {
      id: `strength-${index}`,
      title,
      explanation:
        relatedMoment?.takeaway ??
        `You showed consistent ${title.toLowerCase()} in the analyzed gameplay.`,
      whyItMatters:
        relatedMoment?.why ??
        "This created safer options for your teammates and reduced forced plays.",
      repeatThis: relatedMoment?.recommendedMechanic
        ? `Keep emphasizing ${relatedMoment.recommendedMechanic.replace(/_/g, " ")} in similar situations.`
        : `Repeat the same support habits that produced this ${title.toLowerCase()}.`,
      evidenceMomentIds: related,
    };
  });
}

function buildPriorities(report: ScottyReport, moments: CoachingMomentView[]): PriorityCard[] {
  return report.priorityImprovements.map((issue, index) => {
    const related = relatedMomentIds(moments, issue);
    const relatedMoment = moments.find((m) => related.includes(m.id));
    const mechanic =
      relatedMoment?.recommendedMechanic ??
      report.strategyAnalysis.requiredMechanics[0] ??
      report.controlGuidance[0]?.canonicalMechanic;
    const linkedDrill = report.practiceDrills.find((d) =>
      d.requiredMechanics.some((m) => m === mechanic) ||
      d.name.toLowerCase().includes(issue.toLowerCase().split(" ")[0] ?? ""),
    );
    return {
      id: `priority-${index}`,
      rank: index + 1,
      issue,
      whyItMatters:
        relatedMoment?.why ??
        "Cleaning this up will improve possession quality and reduce defensive vulnerability.",
      evidenceSummary:
        related.length > 0
          ? `Seen across ${related.length} key moment${related.length === 1 ? "" : "s"} in this clip.`
          : "Highlighted as a primary development theme in this report.",
      correction:
        relatedMoment?.takeaway ??
        report.strategyAnalysis.recommendedAdjustment ??
        `Focus on correcting ${issue.toLowerCase()} with deliberate reps.`,
      mechanic,
      linkedDrillId: linkedDrill?.drillId,
    };
  });
}

function buildFocusAreas(moments: CoachingMomentView[]): FocusAreaCard[] {
  const counts = new Map<string, { count: number; good: number; improve: number }>();
  for (const m of moments) {
    const key = m.category.replace(/_/g, " ");
    const cur = counts.get(key) ?? { count: 0, good: 0, improve: 0 };
    cur.count += 1;
    if (m.severity === "good_decision") cur.good += 1;
    if (m.severity === "improvement_opportunity" || m.severity === "key_mistake") cur.improve += 1;
    counts.set(key, cur);
  }
  return [...counts.entries()].map(([name, stats], index) => {
    const qualitativeLabel =
      stats.good > stats.improve
        ? "Strength theme"
        : stats.improve > stats.good
          ? "Development theme"
          : "Mixed theme";
    return {
      id: `focus-${index}`,
      name: name.replace(/\b\w/g, (c) => c.toUpperCase()),
      evidenceCount: stats.count,
      qualitativeLabel,
      interpretation: `${stats.count} observation${stats.count === 1 ? "" : "s"} in this area.`,
    };
  });
}

function buildStrategySections(strategy: StrategyAnalysis): StrategySectionView[] {
  const titleMap: Record<string, string> = {
    forecheck: "Forecheck",
    neutral_zone: "Neutral-zone decisions",
    defensive_zone: "Defensive-zone positioning",
    power_play: "Power play",
    penalty_kill: "Penalty kill",
    breakout: "Breakout",
    cycle: "Offensive-zone cycle",
    transition: "Transition play",
    unknown: "Tactical pattern",
    insufficient_evidence: "Limited tactical evidence",
  };
  if (strategy.strategyCategory === "insufficient_evidence") return [];
  return [
    {
      id: "strategy-primary",
      title: titleMap[strategy.strategyCategory] ?? "Tactical review",
      observedPattern: strategy.observedStrategy,
      impact: strategy.executionAssessment,
      recommendedAdjustment:
        strategy.recommendedAdjustment ??
        strategy.strategicImprovements[0] ??
        "Maintain structure and tighten support timing.",
      cue: strategy.playerResponsibility,
      evidenceTimestamps: strategy.supportingTimestampsSec,
      confidenceLabel: confidenceDisplayLabel(strategy.confidence),
    },
  ];
}

function buildPositionCoaching(
  position: PlayerPosition,
  strategy: StrategyAnalysis,
  report: ScottyReport,
): PositionCoachingView | null {
  if (position === "unknown") return null;
  if (position === "G") {
    return {
      title: "Goalie Coaching",
      position,
      themes: [
        {
          title: "Net presence",
          detail: strategy.playerResponsibility,
        },
        {
          title: "Development focus",
          detail: report.priorityImprovements[0] ?? strategy.executionAssessment,
        },
      ],
    };
  }

  const themesByGroup: Record<string, { title: string; detail: string }[]> = {
    C: [
      { title: "Low support", detail: strategy.playerResponsibility },
      { title: "Middle-lane responsibility", detail: strategy.executionAssessment },
      {
        title: "Center-drive timing",
        detail: strategy.recommendedAdjustment ?? strategy.strategicImprovements[0] ?? strategy.observedStrategy,
      },
    ],
    W: [
      { title: "Wall positioning", detail: strategy.playerResponsibility },
      { title: "Weak-side spacing", detail: strategy.strategicStrengths[0] ?? strategy.executionAssessment },
      {
        title: "Forecheck angle",
        detail: strategy.recommendedAdjustment ?? strategy.strategicImprovements[0] ?? strategy.observedStrategy,
      },
    ],
    D: [
      { title: "Gap control", detail: strategy.playerResponsibility },
      { title: "First pass / retrieval", detail: strategy.executionAssessment },
      {
        title: "Blue-line management",
        detail: strategy.recommendedAdjustment ?? strategy.strategicImprovements[0] ?? strategy.observedStrategy,
      },
    ],
  };

  const group = position === "C" ? "C" : position === "LW" || position === "RW" ? "W" : "D";
  const title =
    position === "C"
      ? "Center Coaching"
      : position === "LW" || position === "RW"
        ? "Wing Coaching"
        : "Defense Coaching";

  return {
    title,
    position,
    themes: themesByGroup[group]!,
  };
}

function formatInputSequence(guidance: ControlGuidance): { label: string; aria: string } {
  const sorted = [...guidance.inputSequence].sort((a, b) => a.order - b.order);
  const parts = sorted.map((s) => {
    if (s.behavior === "hold") return `Hold ${s.input}`;
    if (s.behavior === "tap") return `Tap ${s.input}`;
    if (s.behavior === "motion") return `Move ${s.input}`;
    if (s.behavior === "combo") return s.input;
    return s.input;
  });
  return {
    label: parts.join(" → "),
    aria: parts.join(", then "),
  };
}

function buildControls(report: ScottyReport, platform?: SupportedPlatform): ControlMechanicView[] {
  return report.controlGuidance
    .filter((g) => !platform || g.platform === platform || platform === "unknown")
    .map((g, index) => {
      const seq = formatInputSequence(g);
      const hasVerified =
        g.verificationStatus === "verified" && g.inputSequence.length > 0;
      return {
        id: `control-${index}`,
        mechanicName: g.canonicalMechanic.replace(/_/g, " "),
        platform: g.platform,
        controlScheme: g.controlScheme,
        inputSequenceLabel: hasVerified ? seq.label : "Conceptual coaching — verified inputs not listed",
        inputSequenceAria: hasVerified ? seq.aria : "No verified button sequence provided",
        steps: hasVerified
          ? [...g.inputSequence]
              .sort((a, b) => a.order - b.order)
              .map((s) => ({ order: s.order, input: s.input, behavior: s.behavior }))
          : [],
        whenToUse: g.timingCue,
        correctionCue: g.timingCue,
        verificationStatus: g.verificationStatus,
        hasVerifiedInputs: hasVerified,
      };
    });
}

function buildFaceoffs(faceoffs: FaceoffAnalysis | undefined): FaceoffView | null {
  if (!faceoffs || faceoffs.faceoffCount <= 0) return null;
  if (faceoffs.wins + faceoffs.losses > faceoffs.faceoffCount) return null;
  const winRateLabel =
    faceoffs.faceoffCount > 0
      ? `${Math.round(
          faceoffs.winPercentage ?? (faceoffs.wins / faceoffs.faceoffCount) * 100,
        )}%`
      : null;
  return {
    faceoffCount: faceoffs.faceoffCount,
    wins: faceoffs.wins,
    losses: faceoffs.losses,
    winRateLabel,
    commonSetup: faceoffs.detectedTechniques[0] ?? "Standard stance setup",
    failurePattern: faceoffs.improvements[0] ?? "Timing and counter selection under pressure",
    timingIssue: faceoffs.timingAssessment,
    counterRecommendation: faceoffs.counterSelection,
    drillId: faceoffs.practiceDrillId,
    confidenceLabel: confidenceDisplayLabel(faceoffs.confidence),
  };
}

function buildPractice(
  report: ScottyReport,
  priorities: PriorityCard[],
): PracticeDrillView[] {
  return report.practiceDrills.slice(0, 3).map((drill) => {
    const linked = priorities.find((p) => p.linkedDrillId === drill.drillId);
    const controlLabel =
      drill.verifiedControlInputs.length > 0
        ? [...drill.verifiedControlInputs]
            .sort((a, b) => a.order - b.order)
            .map((s) => s.input)
            .join(" → ")
        : "See drill setup";
    return {
      drill,
      whySelected:
        linked != null
          ? `Selected to address priority #${linked.rank}: ${linked.issue}`
          : `Supports ${drill.objective}`,
      linkedPriorityId: linked?.id,
      controlLabel,
    };
  });
}

function buildNextFocus(priorities: PriorityCard[], strategy: StrategyAnalysis): NextGameFocusView {
  const primary = priorities[0];
  return {
    primaryFocus:
      primary?.issue ??
      strategy.strategicImprovements[0] ??
      "Stay structured through the next transition.",
    supportingCue: primary?.mechanic
      ? `Stay focused on ${primary.mechanic.replace(/_/g, " ")}.`
      : strategy.playerResponsibility,
    successCondition:
      primary?.correction ??
      strategy.recommendedAdjustment ??
      "Complete the practice plan success criteria before the next session.",
  };
}

export function buildCoachingReportView(payload: AnalysisReportResponse): CoachingReportView {
  const { report } = payload;
  const moments = buildMoments(report);
  const strengths = buildStrengths(report, moments);
  const priorities = buildPriorities(report, moments);
  const focusAreas = buildFocusAreas(moments);
  const strategySections = buildStrategySections(report.strategyAnalysis);
  const position = report.playerAttribution.position;
  // Position coaching is derived only for the confirmed position (no cross-position guidance).
  const positionCoaching = buildPositionCoaching(position, report.strategyAnalysis, report);
  const controls = buildControls(report, payload.platform);
  const faceoffs = buildFaceoffs(report.faceoffAnalysis);
  const practiceDrills = buildPractice(report, priorities);
  const nextGameFocus = buildNextFocus(priorities, report.strategyAnalysis);

  const filterSet = new Set<MomentFilterCategory>(["all"]);
  for (const m of moments) filterSet.add(m.filterCategory);

  const navigation: { id: ReportNavSectionId; label: string }[] = [
    { id: "overview", label: "Overview" },
  ];
  if (focusAreas.length > 0) navigation.push({ id: "scorecard", label: "Scorecard" });
  if (strengths.length > 0) navigation.push({ id: "strengths", label: "Strengths" });
  if (priorities.length > 0) navigation.push({ id: "improvements", label: "Improvements" });
  if (moments.length > 0) navigation.push({ id: "moments", label: "Gameplay Moments" });
  if (strategySections.length > 0) navigation.push({ id: "strategy", label: "Strategy" });
  if (positionCoaching) navigation.push({ id: "position", label: "Position" });
  if (controls.length > 0) navigation.push({ id: "controls", label: "Controls" });
  if (faceoffs) navigation.push({ id: "faceoffs", label: "Faceoffs" });
  if (practiceDrills.length > 0) navigation.push({ id: "practice", label: "Practice Plan" });
  navigation.push({ id: "next", label: "Next Game" });
  navigation.push({ id: "about", label: "About" });

  const durationLabel = formatDuration(payload.mediaDurationSec);
  const mediaNotice = payload.sourceMediaAvailable
    ? payload.sourceMediaExpiresAt
      ? `Gameplay video available until ${new Date(payload.sourceMediaExpiresAt).toLocaleString()}.`
      : "Gameplay video is currently available."
    : "The original gameplay video has been deleted according to the retention policy. Your coaching report remains available.";

  return {
    applicationRequestId: payload.applicationRequestId,
    uploadId: payload.uploadId,
    report,
    header: {
      title: "Scotty’s Gameplay Review",
      subtitle:
        "A coaching breakdown of your decisions, positioning, mechanics, and next development priorities.",
      gameTitle: report.gameContext.selectedGameTitle,
      gameMode: payload.gameMode,
      position: positionLabel(position),
      platform: platformLabel(payload.platform ?? report.controlGuidance[0]?.platform),
      controlScheme: schemeLabel(payload.controlScheme ?? report.controlGuidance[0]?.controlScheme),
      mediaClassification: payload.mediaClassification?.replace(/_/g, " "),
      analysisDate: new Date(report.generatedAt).toLocaleString(),
      videoDurationLabel: durationLabel,
      confirmationSource:
        report.playerAttribution.confirmationState === "confirmed"
          ? "Player confirmed"
          : report.playerAttribution.confirmationState === "auto_accepted"
            ? "Auto-accepted identification"
            : "Unconfirmed identification",
      simulatorMode: payload.simulatorMode === true,
    },
    sourceMedia: {
      available: payload.sourceMediaAvailable,
      expiresAt: payload.sourceMediaExpiresAt ?? null,
      notice: mediaNotice,
    },
    executive: {
      overallAssessment:
        report.strategyAnalysis.executionAssessment ||
        "A structured clip with clear development opportunities.",
      performanceSummary: [
        strengths[0]
          ? `Your strongest theme was ${strengths[0].title.toLowerCase()}.`
          : "Several positive habits appeared in the footage.",
        priorities[0]
          ? `The largest limiter right now is ${priorities[0].issue.toLowerCase()}.`
          : "Keep reinforcing the habits that already work.",
      ].join(" "),
      strongestArea: strengths[0]?.title ?? "Support habits",
      highestPriority: priorities[0]?.issue ?? "Continue structured development",
      nextSessionObjective:
        practiceDrills[0]?.drill.objective ?? nextGameFocus.primaryFocus,
    },
    overallScore: null,
    focusAreas,
    strengths,
    priorities,
    initialPriorityCount: INITIAL_PRIORITY_COUNT,
    moments,
    momentFilterCategories: [...filterSet],
    strategySections,
    positionCoaching,
    controls,
    faceoffs,
    practiceDrills,
    nextGameFocus,
    navigation,
    limitations: [
      ...report.uncertaintyDisclosures,
      ...report.qualityValidation.issues,
      ...(payload.sourceMediaAvailable
        ? []
        : ["Source video expired after analysis; timestamps and coaching notes remain saved."]),
    ],
    metadata: {
      reportVersion: report.reportVersion,
      rubricVersion: report.rubricVersion,
      strategyKnowledgeVersion: report.strategyKnowledgeVersion,
      controlKnowledgeVersion: report.controlKnowledgeVersion,
      generatedAt: report.generatedAt,
      qualityPassed: report.qualityValidation.passed,
      qualityIssues: report.qualityValidation.issues,
    },
  };
}

export function formatMomentTimestamp(sec: number | null): string {
  if (sec == null) return "—";
  return formatTimestamp(sec);
}

export { formatTimestamp };
