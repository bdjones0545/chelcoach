import { z } from "zod";
import { controlGuidanceSchema } from "./controls";
import { practiceDrillListSchema } from "./drills";
import { evidenceConfidenceLabelSchema, playerPositionSchema } from "./enums";
import { faceoffAnalysisSchema } from "./faceoffs";
import { gameContextSchema } from "./game-context";
import { controlledPlayerIdentificationSchema } from "./player-identification";
import { strategyAnalysisSchema } from "./strategies";
import { SCOTTY_CONTRACT_VERSION, scottyContractVersionSchema } from "./version";

export const observationCategorySchema = z.enum([
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
export type ObservationCategory = z.infer<typeof observationCategorySchema>;

export const scottyObservationSchema = z.object({
  timestampSec: z.number().nonnegative().max(1800).optional(),
  timestampRangeSec: z
    .object({
      start: z.number().nonnegative().max(1800),
      end: z.number().nonnegative().max(1800),
    })
    .optional(),
  category: observationCategorySchema,
  observedAction: z.string().trim().min(1).max(400),
  attributionExplanation: z.string().trim().min(1).max(400),
  coachingInterpretation: z.string().trim().min(1).max(600),
  confidence: evidenceConfidenceLabelSchema,
  recommendedMechanic: z.string().trim().max(160).optional(),
});
export type ScottyObservation = z.infer<typeof scottyObservationSchema>;

export const qualityValidationResultSchema = z.object({
  passed: z.boolean(),
  issues: z.array(z.string().trim().max(200)).max(20),
  validatedAt: z.string().datetime({ offset: true }),
});
export type QualityValidationResult = z.infer<typeof qualityValidationResultSchema>;

export const playerAttributionSchema = z.object({
  position: playerPositionSchema,
  jerseyNumber: z.number().int().min(0).max(99).nullable(),
  indicatorColor: z.string().trim().max(40).nullable(),
  confirmationState: z.enum(["confirmed", "auto_accepted", "unconfirmed"]),
  identification: controlledPlayerIdentificationSchema.optional(),
});
export type PlayerAttribution = z.infer<typeof playerAttributionSchema>;

/**
 * Full Scotty coaching report — no chain-of-thought / raw model reasoning.
 */
/**
 * A rubric-based estimate of overall play, computed by the analysis provider from the sampled
 * frames. It is an estimate, not a measurement: the basis (frame count, duration) and confidence
 * travel with it so the UI can say so. Absent when the provider produced no rubric scores.
 */
export const performanceMetricSchema = z.object({
  key: z.string().trim().min(1).max(64),
  label: z.string().trim().min(1).max(80),
  score: z.number().int().min(0).max(100),
  note: z.string().trim().max(300).optional(),
});
export type PerformanceMetric = z.infer<typeof performanceMetricSchema>;

export const performanceEstimateSchema = z.object({
  /** 0–1000, the weighted rubric average. */
  chelRating: z.number().int().min(0).max(1000),
  metrics: z.array(performanceMetricSchema).max(12),
  basis: z.object({
    frameCount: z.number().int().min(0).max(200),
    durationSec: z.number().nonnegative().max(1800),
    rubricVersion: z.string().trim().min(1).max(64),
  }),
  confidence: evidenceConfidenceLabelSchema,
});
export type PerformanceEstimate = z.infer<typeof performanceEstimateSchema>;

export const scottyReportSchema = z.object({
  contractVersion: scottyContractVersionSchema.default(SCOTTY_CONTRACT_VERSION),
  reportId: z.string().trim().min(1).max(128),
  jobId: z.string().trim().min(1).max(128),
  uploadId: z.string().trim().min(1).max(128),
  generatedAt: z.string().datetime({ offset: true }),
  gameContext: gameContextSchema,
  playerAttribution: playerAttributionSchema,
  controlledPlayerConfidence: evidenceConfidenceLabelSchema,
  performanceEstimate: performanceEstimateSchema.optional(),
  playerSpecificObservations: z.array(scottyObservationSchema).max(40),
  strengths: z.array(z.string().trim().max(240)).max(10),
  priorityImprovements: z.array(z.string().trim().max(240)).max(10),
  strategyAnalysis: strategyAnalysisSchema,
  /** Omit entirely when no faceoffs detected. */
  faceoffAnalysis: faceoffAnalysisSchema.optional(),
  controlGuidance: z.array(controlGuidanceSchema).max(10),
  practiceDrills: practiceDrillListSchema,
  uncertaintyDisclosures: z.array(z.string().trim().max(300)).max(20),
  rubricVersion: z.string().trim().min(1).max(64),
  strategyKnowledgeVersion: z.string().trim().min(1).max(64),
  controlKnowledgeVersion: z.string().trim().min(1).max(64),
  reportVersion: z.string().trim().min(1).max(64),
  qualityValidation: qualityValidationResultSchema,
});
export type ScottyReport = z.infer<typeof scottyReportSchema>;
