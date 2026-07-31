import { z } from "zod";
import {
  evidenceConfidenceLabelSchema,
  playerPositionSchema,
  teamSideSchema,
} from "./enums";

const boundedString = (max: number) => z.string().trim().min(1).max(max);

export const controlledPlayerIdentificationSchema = z.object({
  detected: z.boolean(),
  confidence: z.number().min(0).max(1),
  confidenceLabel: evidenceConfidenceLabelSchema,
  position: playerPositionSchema,
  jerseyNumber: z.number().int().min(0).max(99).nullable(),
  indicatorColor: z.string().trim().max(40).nullable(),
  teamSide: teamSideSchema,
  evidenceTimestampsSec: z.array(z.number().nonnegative().max(1800)).max(20),
  evidenceSummaries: z.array(boundedString(300)).max(20),
  uncertainties: z.array(boundedString(300)).max(20),
  userConfirmed: z.boolean(),
  confirmationRequired: z.boolean(),
  candidateId: z.string().trim().min(1).max(128).optional(),
});
export type ControlledPlayerIdentification = z.infer<
  typeof controlledPlayerIdentificationSchema
>;
