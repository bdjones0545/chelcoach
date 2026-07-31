import { z } from "zod";
import { playerPositionSchema } from "./enums";
import { SCOTTY_CONTRACT_VERSION, scottyContractVersionSchema } from "./version";

/**
 * Frame reference owned by the application — resolves later to a short-lived URL.
 * Not a permanent public URL.
 */
export const frameReferenceSchema = z.object({
  frameId: z.string().trim().min(1).max(128),
  uploadId: z.string().trim().min(1).max(128),
  timestampSec: z.number().nonnegative().max(1800).optional(),
});
export type FrameReference = z.infer<typeof frameReferenceSchema>;

export const playerConfirmationRequestSchema = z.object({
  contractVersion: scottyContractVersionSchema.default(SCOTTY_CONTRACT_VERSION),
  jobId: z.string().trim().min(1).max(128),
  uploadId: z.string().trim().min(1).max(128),
  selectedCandidateId: z.string().trim().min(1).max(128),
  representativeFrame: frameReferenceSchema,
  confirmedPosition: playerPositionSchema.optional(),
  confirmedJerseyNumber: z.number().int().min(0).max(99).optional(),
  confirmedIndicatorColor: z.string().trim().max(40).optional(),
  confirmedAt: z.string().datetime({ offset: true }),
});
export type PlayerConfirmationRequest = z.infer<typeof playerConfirmationRequestSchema>;
