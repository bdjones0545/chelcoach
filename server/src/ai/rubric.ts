/**
 * ChelCoach gameplay-analysis rubric (v1).
 *
 * Aligns with the shared AnalysisReport contract and product language.
 * Not a scientifically validated instrument — model-assessed coaching guidance
 * grounded in visible frame evidence only.
 */
import { RUBRIC_VERSION } from "./versions";

export const gameplayRubric = {
  version: RUBRIC_VERSION,
  purpose:
    "Score NHL video-game gameplay from sampled frames + verified clip metadata only.",
  scoreDimensions: [
    {
      key: "offensive-iq",
      label: "Offensive IQ",
      icon: "sports_hockey",
      range: [0, 100] as const,
      evidence:
        "Visible offensive-zone structure, support, net-front presence, cycle pressure.",
    },
    {
      key: "defense",
      label: "Defense",
      icon: "shield",
      range: [0, 100] as const,
      evidence: "Gap control, stick positioning, board battles, defensive-zone coverage.",
    },
    {
      key: "passing",
      label: "Passing",
      icon: "sync_alt",
      range: [0, 100] as const,
      evidence: "Visible completed/attempted passes, support options, outlet looks.",
    },
    {
      key: "positioning",
      label: "Positioning",
      icon: "location_on",
      range: [0, 100] as const,
      evidence: "Ice position relative to puck/teammates/opponents in sampled frames.",
    },
    {
      key: "decision-making",
      label: "Decision Making",
      icon: "psychology",
      range: [0, 100] as const,
      evidence: "Visible choices under pressure: hold vs pass, pinch vs gap, shot selection cues.",
    },
    {
      key: "puck-management",
      label: "Puck Management",
      icon: "front_loader",
      range: [0, 100] as const,
      evidence: "Puck protection, turnovers visible in frames, controlled exits/entries.",
    },
  ],
  overall: {
    chelRating: {
      range: [0, 1000] as const,
      method:
        "Model-assessed composite within rubric criteria from component metrics — not a weighted formula claim.",
    },
    overallGrade: "Letter-style grade consistent with chelRating (e.g. A/B/C with optional +/-).",
    percentile: "Qualitative band string (e.g. Top 25% of Players) — cautious, not population-validated.",
  },
  confidence:
    "Lower confidence when frames are sparse, blurry, UI-obscured, or lack clear gameplay context. Prefer under-claiming.",
  strengths:
    "Select biggestStrength from the clearest positive visible pattern. Do not invent strengths to fill a quota.",
  improvements:
    "Select biggestWeakness / mistakes from the clearest negative visible pattern. Omit fabricated coaching moments.",
  coachingMoments:
    "0–3 moments only when evidence supports them. Timestamps must match supplied sample timestamps (mm:ss). Types: great | missed | breakdown.",
  insufficientEvidence:
    "When evidence is thin: lower scores toward mid-band, reduce eventsAnalyzed, fewer moments, note uncertainty in commentary, never fabricate stats or biography.",
  forbiddenClaims: [
    "controller inputs",
    "hidden game state",
    "complete possession history",
    "audio",
    "events between sampled frames",
    "player identity / rank / matchmaking",
    "statistics not visibly present",
  ],
} as const;

/** Compact text block embedded in the analysis prompt. */
export function rubricPromptSection(): string {
  const dims = gameplayRubric.scoreDimensions
    .map((d) => `- ${d.label} (${d.key}): 0–100 from ${d.evidence}`)
    .join("\n");
  return [
    `Rubric version: ${gameplayRubric.version}`,
    "Score dimensions:",
    dims,
    `Overall chelRating 0–1000: ${gameplayRubric.overall.chelRating.method}`,
    `Confidence: ${gameplayRubric.confidence}`,
    `Strengths: ${gameplayRubric.strengths}`,
    `Improvements: ${gameplayRubric.improvements}`,
    `Coaching moments: ${gameplayRubric.coachingMoments}`,
    `Insufficient evidence: ${gameplayRubric.insufficientEvidence}`,
    `Never claim access to: ${gameplayRubric.forbiddenClaims.join("; ")}.`,
  ].join("\n");
}
