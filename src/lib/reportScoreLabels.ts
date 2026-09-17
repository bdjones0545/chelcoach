/**
 * Centralized qualitative score labels (Step 8).
 * Only used when the report actually includes numeric scores (`performanceEstimate`).
 */

export type ScoreQualitativeLabel = "Elite" | "Strong" | "Developing" | "Needs attention";

/** Thresholds assume a 0–100 coaching scale when present. */
export const SCORE_LABEL_THRESHOLDS = {
  elite: 90,
  strong: 75,
  developing: 55,
} as const;

export function qualitativeScoreLabel(score: number): ScoreQualitativeLabel {
  if (score >= SCORE_LABEL_THRESHOLDS.elite) return "Elite";
  if (score >= SCORE_LABEL_THRESHOLDS.strong) return "Strong";
  if (score >= SCORE_LABEL_THRESHOLDS.developing) return "Developing";
  return "Needs attention";
}

export function confidenceDisplayLabel(
  confidence: string,
): "High confidence" | "Moderate confidence" | "Limited evidence" {
  if (confidence === "official" || confidence === "very_high" || confidence === "high") {
    return "High confidence";
  }
  if (confidence === "moderate") return "Moderate confidence";
  return "Limited evidence";
}

/**
 * Band for a 0–1000 Chel Rating. Mirrors the gateway's `percentile_label` bands and, like it, is
 * an honest band label — not a claim about where the player sits in a real population.
 */
export function chelRatingBandLabel(rating: number): string {
  if (rating >= 900) return "Elite band";
  if (rating >= 800) return "High band";
  if (rating >= 700) return "Above-average band";
  if (rating >= 600) return "Average band";
  if (rating >= 500) return "Developing band";
  return "Foundational band";
}
