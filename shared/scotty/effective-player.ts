/**
 * Effective controlled-player context for analysis submission.
 * Derived from identification + confirmation; does not overwrite upload snapshots.
 */
import { z } from "zod";
import {
  evidenceConfidenceLabelSchema,
  playerPositionSchema,
  teamSideSchema,
} from "./enums";

export const effectivePlayerSourceSchema = z.enum([
  "user_confirmation",
  "user_correction",
  "high_confidence_identification",
  "upload_hints",
]);
export type EffectivePlayerSource = z.infer<typeof effectivePlayerSourceSchema>;

export const effectivePlayerContextSchema = z.object({
  position: playerPositionSchema,
  jerseyNumber: z.number().int().min(0).max(99).nullable(),
  indicatorColor: z.string().trim().max(40).nullable(),
  teamSide: teamSideSchema,
  confidence: z.number().min(0).max(1),
  confidenceLabel: evidenceConfidenceLabelSchema,
  source: effectivePlayerSourceSchema,
  identificationId: z.string().trim().min(1).max(128),
  confirmationId: z.string().trim().min(1).max(128).optional(),
  userConfirmed: z.boolean(),
});
export type EffectivePlayerContext = z.infer<typeof effectivePlayerContextSchema>;
