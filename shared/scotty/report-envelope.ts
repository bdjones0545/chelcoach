/**
 * Public analysis report response — persisted report plus safe media context (Step 8).
 * Never includes storage keys, owner IDs, or provider URLs.
 */
import { z } from "zod";
import { controlSchemeSchema, supportedPlatformSchema } from "./enums";
import { mediaClassificationSchema } from "./media-classification";
import { scottyReportSchema } from "./report";

export const analysisReportResponseSchema = z.object({
  applicationRequestId: z.string().trim().min(1).max(128),
  uploadId: z.string().trim().min(1).max(128),
  report: scottyReportSchema,
  sourceMediaAvailable: z.boolean(),
  sourceMediaExpiresAt: z.string().datetime({ offset: true }).nullable().optional(),
  mediaClassification: mediaClassificationSchema.optional(),
  mediaDurationSec: z.number().nonnegative().max(1800).nullable().optional(),
  platform: supportedPlatformSchema.optional(),
  controlScheme: controlSchemeSchema.optional(),
  gameMode: z.string().trim().max(64).optional(),
  /** Dev/test only. */
  simulatorMode: z.boolean().optional(),
});
export type AnalysisReportResponse = z.infer<typeof analysisReportResponseSchema>;
