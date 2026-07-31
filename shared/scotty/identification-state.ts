/**
 * Durable controlled-player identification state (Step 3).
 * Separate from upload status and future analysis-job status.
 */
import { z } from "zod";
import {
  evidenceConfidenceLabelSchema,
  playerIdentificationStatusSchema,
  playerPositionSchema,
  teamSideSchema,
} from "./enums";
import { SCOTTY_CONTRACT_VERSION, scottyContractVersionSchema } from "./version";
import { MAX_CONFIRMATION_FRAMES, MAX_PLAYER_CANDIDATES, playerCandidateSchema } from "./player-candidate";
import { frameReferenceSchema } from "./confirmation";

export const DEFAULT_PLAYER_IDENTITY_CONFIDENCE_THRESHOLD = 0.75;

export function confidenceRequiresConfirmation(
  confidence: number,
  threshold: number = DEFAULT_PLAYER_IDENTITY_CONFIDENCE_THRESHOLD,
): boolean {
  return confidence < threshold;
}

export function confidenceLabelFromScore(
  confidence: number,
): z.infer<typeof evidenceConfidenceLabelSchema> {
  if (confidence >= 0.9) return "very_high";
  if (confidence >= 0.75) return "high";
  if (confidence >= 0.55) return "moderate";
  if (confidence >= 0.35) return "low";
  return "insufficient";
}

const boundedString = (max: number) => z.string().trim().min(1).max(max);

export const publicConfirmationFrameSchema = z.object({
  frameId: z.string().trim().min(1).max(128),
  uploadId: z.string().trim().min(1).max(128),
  timestampSec: z.number().nonnegative().max(1800),
  mimeType: z.enum(["image/jpeg", "image/webp"]),
  width: z.number().int().positive().max(4096),
  height: z.number().int().positive().max(4096),
  byteSize: z.number().int().positive(),
  /** Application route for authenticated frame bytes — not a storage key. */
  accessUrl: z.string().trim().min(1).max(500),
  expiresAt: z.string().datetime({ offset: true }),
});
export type PublicConfirmationFrame = z.infer<typeof publicConfirmationFrameSchema>;

export const identifiedPlayerSummarySchema = z.object({
  position: playerPositionSchema,
  jerseyNumber: z.number().int().min(0).max(99).nullable(),
  indicatorColor: z.string().trim().max(40).nullable(),
  teamSide: teamSideSchema,
});
export type IdentifiedPlayerSummary = z.infer<typeof identifiedPlayerSummarySchema>;

/** Safe public identification response (no storage keys / provider payloads). */
export const publicPlayerIdentificationSchema = z.object({
  identificationId: z.string().trim().min(1).max(128),
  uploadId: z.string().trim().min(1).max(128),
  contractVersion: scottyContractVersionSchema.default(SCOTTY_CONTRACT_VERSION),
  status: playerIdentificationStatusSchema,
  detected: z.boolean(),
  confidence: z.number().min(0).max(1),
  confidenceLabel: evidenceConfidenceLabelSchema,
  player: identifiedPlayerSummarySchema.optional(),
  uncertainties: z.array(boundedString(300)).max(20),
  userConfirmed: z.boolean(),
  confirmationId: z.string().trim().min(1).max(128).optional(),
  frames: z.array(publicConfirmationFrameSchema).max(MAX_CONFIRMATION_FRAMES),
  candidates: z.array(playerCandidateSchema).max(MAX_PLAYER_CANDIDATES),
  /** When true, one additional candidate-generation attempt remains. */
  additionalExtractionAvailable: z.boolean(),
  sourceExpiresAt: z.string().datetime({ offset: true }),
  retentionNotice: z.string().trim().min(1).max(500),
  errorCode: z.string().optional(),
  errorMessage: z.string().optional(),
});
export type PublicPlayerIdentification = z.infer<typeof publicPlayerIdentificationSchema>;

export const startPlayerIdentificationRequestSchema = z.object({
  contractVersion: scottyContractVersionSchema.default(SCOTTY_CONTRACT_VERSION),
  /** Dev/CI only — ignored in production. */
  fixtureScenario: z
    .enum([
      "high_confidence_center",
      "low_confidence_multiple_players",
      "indicator_not_visible",
      "jersey_number_conflict",
      "candidate_none_correct",
      "identification_failure",
      "expired_upload",
    ])
    .optional(),
});
export type StartPlayerIdentificationRequest = z.infer<
  typeof startPlayerIdentificationRequestSchema
>;

export const playerConfirmationSubmitSchema = z.object({
  contractVersion: scottyContractVersionSchema.default(SCOTTY_CONTRACT_VERSION),
  /** Optional until a future analysis job exists. */
  jobId: z.string().trim().min(1).max(128).optional(),
  uploadId: z.string().trim().min(1).max(128),
  selectedCandidateId: z.string().trim().min(1).max(128),
  representativeFrame: frameReferenceSchema,
  confirmedPosition: playerPositionSchema.optional(),
  confirmedJerseyNumber: z.number().int().min(0).max(99).optional(),
  confirmedIndicatorColor: z.string().trim().max(40).optional(),
  confirmedTeamSide: teamSideSchema.optional(),
  confirmedAt: z.string().datetime({ offset: true }),
});
export type PlayerConfirmationSubmit = z.infer<typeof playerConfirmationSubmitSchema>;

export const noneOfTheAboveRequestSchema = z.object({
  contractVersion: scottyContractVersionSchema.default(SCOTTY_CONTRACT_VERSION),
  uploadId: z.string().trim().min(1).max(128),
  /** Request one additional bounded extraction when available. */
  requestAdditionalExtraction: z.boolean().default(false),
  hints: z
    .object({
      jerseyNumber: z.number().int().min(0).max(99).optional(),
      indicatorColor: z.string().trim().max(40).optional(),
      position: playerPositionSchema.optional(),
      teamSide: teamSideSchema.optional(),
    })
    .optional(),
  /** Explicit only — never silently overwrite global profile. */
  saveHintsAsDefaults: z.boolean().default(false),
});
export type NoneOfTheAboveRequest = z.infer<typeof noneOfTheAboveRequestSchema>;

export const correctIdentificationRequestSchema = z.object({
  contractVersion: scottyContractVersionSchema.default(SCOTTY_CONTRACT_VERSION),
  reason: z.literal("not_my_player"),
});
export type CorrectIdentificationRequest = z.infer<typeof correctIdentificationRequestSchema>;
