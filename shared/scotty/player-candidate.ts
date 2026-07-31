/**
 * Bounded candidate skaters for controlled-player confirmation.
 */
import { z } from "zod";
import { boundingBoxSchema } from "./bounding-box";
import { playerPositionSchema, teamSideSchema } from "./enums";

export const MAX_PLAYER_CANDIDATES = 4;
export const MAX_CONFIRMATION_FRAMES = 3;

const boundedString = (max: number) => z.string().trim().min(1).max(max);

export const playerCandidateSchema = z.object({
  candidateId: z.string().trim().min(1).max(128),
  uploadId: z.string().trim().min(1).max(128),
  representativeFrameId: z.string().trim().min(1).max(128),
  timestampSec: z.number().nonnegative().max(1800),
  boundingBox: boundingBoxSchema,
  position: playerPositionSchema.optional(),
  jerseyNumber: z.number().int().min(0).max(99).nullable().optional(),
  indicatorColor: z.string().trim().max(40).nullable().optional(),
  teamSide: teamSideSchema.optional(),
  confidence: z.number().min(0).max(1),
  evidenceSummary: boundedString(300),
  /** Application-controlled thumbnail path — never a storage object key. */
  thumbnailUrl: z.string().trim().min(1).max(500),
  displayLabel: boundedString(80),
  expiresAt: z.string().datetime({ offset: true }),
});
export type PlayerCandidate = z.infer<typeof playerCandidateSchema>;

export const playerCandidateListSchema = z
  .array(playerCandidateSchema)
  .max(MAX_PLAYER_CANDIDATES);
