/**
 * Centralized qualitative score labels (Step 8).
 * Only used when the report actually includes numeric scores.
 * ScottyReport currently has no overall/dimension scores — helpers remain ready.
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
