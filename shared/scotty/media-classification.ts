/**
 * Trusted-duration media classification thresholds (centralized, configurable).
 */
import { z } from "zod";
import { mediaClassificationSchema, type MediaClassification } from "./enums";
import { SCOTTY_MAX_DURATION_SEC } from "./upload";

export const mediaClassificationThresholdsSchema = z.object({
  /** short_clip: (0, shortMaxSec] */
  shortMaxSec: z.number().positive(),
  /** extended_clip: (shortMaxSec, extendedMaxSec) */
  extendedMaxSec: z.number().positive(),
  /** full_game: [extendedMaxSec, maxDurationSec] */
  maxDurationSec: z.number().positive(),
});
export type MediaClassificationThresholds = z.infer<typeof mediaClassificationThresholdsSchema>;

export const DEFAULT_MEDIA_CLASSIFICATION_THRESHOLDS: MediaClassificationThresholds =
  mediaClassificationThresholdsSchema.parse({
    shortMaxSec: 120,
    extendedMaxSec: 900,
    maxDurationSec: SCOTTY_MAX_DURATION_SEC,
  });

export function classifyMediaDuration(
  durationSec: number,
  thresholds: MediaClassificationThresholds = DEFAULT_MEDIA_CLASSIFICATION_THRESHOLDS,
): MediaClassification {
  if (!Number.isFinite(durationSec) || durationSec <= 0) {
    throw new Error("duration must be positive");
  }
  if (durationSec > thresholds.maxDurationSec) {
    throw new Error("VIDEO_DURATION_EXCEEDED");
  }
  if (durationSec <= thresholds.shortMaxSec) return "short_clip";
  if (durationSec < thresholds.extendedMaxSec) return "extended_clip";
  return "full_game";
}

export { mediaClassificationSchema };
