import { z } from "zod";
import { evidenceConfidenceLabelSchema, playerPositionSchema } from "./enums";

export const strategyCategorySchema = z.enum([
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
export type StrategyCategory = z.infer<typeof strategyCategorySchema>;

export const strategyAnalysisSchema = z.object({
  observedStrategy: z.string().trim().min(1).max(160),
  strategyCategory: strategyCategorySchema,
  controlledPlayerPosition: playerPositionSchema,
  playerResponsibility: z.string().trim().max(400),
  executionAssessment: z.string().trim().max(600),
  strategicStrengths: z.array(z.string().trim().max(200)).max(10),
  strategicImprovements: z.array(z.string().trim().max(200)).max(10),
  recommendedAdjustment: z.string().trim().max(400).optional(),
  knownCounters: z.array(z.string().trim().max(200)).max(10),
  requiredMechanics: z.array(z.string().trim().max(120)).max(20),
  confidence: evidenceConfidenceLabelSchema,
  supportingTimestampsSec: z.array(z.number().nonnegative().max(1800)).max(20),
});
export type StrategyAnalysis = z.infer<typeof strategyAnalysisSchema>;
