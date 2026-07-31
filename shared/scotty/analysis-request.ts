import { z } from "zod";
import { gameContextSchema } from "./game-context";
import { mediaClassificationSchema } from "./enums";
import { playerContextSchema } from "./player-context";
import { trustedMediaMetadataSchema } from "./upload";
import { SCOTTY_CONTRACT_VERSION, scottyContractVersionSchema } from "./version";

export const requestedCapabilitiesSchema = z.object({
  identifyControlledPlayer: z.boolean(),
  analyzeGameplay: z.boolean(),
  analyzeStrategies: z.boolean(),
  analyzeFaceoffs: z.boolean(),
  includeControlGuidance: z.boolean(),
  generatePracticeDrills: z.boolean(),
});
export type RequestedCapabilities = z.infer<typeof requestedCapabilitiesSchema>;

export const DEFAULT_REQUESTED_CAPABILITIES: RequestedCapabilities = {
  identifyControlledPlayer: true,
  analyzeGameplay: true,
  analyzeStrategies: true,
  analyzeFaceoffs: true,
  includeControlGuidance: true,
  generatePracticeDrills: true,
};

/**
 * Versioned analysis request — no storage credentials or permanent public URLs.
 */
export const scottyAnalysisRequestSchema = z.object({
  contractVersion: scottyContractVersionSchema,
  requestId: z.string().trim().min(1).max(128),
  idempotencyKey: z.string().trim().min(1).max(128),
  ownerId: z.string().trim().min(1).max(128),
  uploadId: z.string().trim().min(1).max(128),
  mediaClassification: mediaClassificationSchema,
  gameContext: gameContextSchema,
  playerContext: playerContextSchema,
  mediaMetadata: trustedMediaMetadataSchema,
  capabilities: requestedCapabilitiesSchema.default(DEFAULT_REQUESTED_CAPABILITIES),
  createdAt: z.string().datetime({ offset: true }),
});
export type ScottyAnalysisRequest = z.infer<typeof scottyAnalysisRequestSchema>;

export function createAnalysisRequestDefaults(
  partial: Omit<ScottyAnalysisRequest, "contractVersion" | "capabilities"> & {
    capabilities?: RequestedCapabilities;
  },
): ScottyAnalysisRequest {
  return scottyAnalysisRequestSchema.parse({
    contractVersion: SCOTTY_CONTRACT_VERSION,
    capabilities: DEFAULT_REQUESTED_CAPABILITIES,
    ...partial,
  });
}
