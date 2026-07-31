import { z } from "zod";
import { analysisProviderSchema, scottyJobStatusSchema } from "./enums";
import { gameContextSchema } from "./game-context";
import { playerContextSchema } from "./player-context";
import { scottyErrorCodeSchema } from "./errors";
import { SCOTTY_CONTRACT_VERSION, scottyContractVersionSchema } from "./version";

export const scottyJobReceiptSchema = z.object({
  contractVersion: scottyContractVersionSchema.default(SCOTTY_CONTRACT_VERSION),
  jobId: z.string().trim().min(1).max(128),
  uploadId: z.string().trim().min(1).max(128),
  provider: analysisProviderSchema,
  externalScottyJobId: z.string().trim().max(128).optional(),
  idempotencyKey: z.string().trim().min(1).max(128),
  status: scottyJobStatusSchema,
  createdAt: z.string().datetime({ offset: true }),
});
export type ScottyJobReceipt = z.infer<typeof scottyJobReceiptSchema>;

export const scottyJobStatusResponseSchema = z.object({
  contractVersion: scottyContractVersionSchema.default(SCOTTY_CONTRACT_VERSION),
  jobId: z.string().trim().min(1).max(128),
  uploadId: z.string().trim().min(1).max(128),
  provider: analysisProviderSchema,
  externalScottyJobId: z.string().trim().max(128).optional(),
  status: scottyJobStatusSchema,
  phaseProgress: z.number().min(0).max(100).optional(),
  message: z.string().trim().max(300).optional(),
  playerContext: playerContextSchema.optional(),
  gameContext: gameContextSchema.optional(),
  errorCode: scottyErrorCodeSchema.optional(),
  errorMessage: z.string().trim().max(500).optional(),
  reportReady: z.boolean(),
  updatedAt: z.string().datetime({ offset: true }),
});
export type ScottyJobStatusResponse = z.infer<typeof scottyJobStatusResponseSchema>;
