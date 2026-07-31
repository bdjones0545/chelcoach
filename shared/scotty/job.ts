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
  applicationRequestId: z.string().trim().min(1).max(128).optional(),
  status: scottyJobStatusSchema,
  /** Monotonic lifecycle sequence — never regresses. */
  sequenceNumber: z.number().int().positive().optional(),
  /** Advisory poll delay; null when paused (confirmation) or terminal. */
  pollAfterMs: z.number().int().positive().max(120_000).nullable().optional(),
  userActionRequired: z.boolean().optional(),
  terminal: z.boolean().optional(),
  /** Do not use as a fake completion percentage. */
  phaseProgress: z.number().min(0).max(100).optional(),
  message: z.string().trim().max(300).optional(),
  playerContext: playerContextSchema.optional(),
  gameContext: gameContextSchema.optional(),
  errorCode: scottyErrorCodeSchema.optional(),
  errorMessage: z.string().trim().max(500).optional(),
  reportReady: z.boolean(),
  enteredAt: z.string().datetime({ offset: true }).optional(),
  updatedAt: z.string().datetime({ offset: true }),
});
export type ScottyJobStatusResponse = z.infer<typeof scottyJobStatusResponseSchema>;

/** Safe application-facing analysis status (ownership already verified). */
export const applicationAnalysisStatusSchema = z.object({
  applicationRequestId: z.string().trim().min(1).max(128),
  uploadId: z.string().trim().min(1).max(128),
  provider: analysisProviderSchema,
  status: scottyJobStatusSchema,
  sequenceNumber: z.number().int().positive(),
  pollAfterMs: z.number().int().positive().max(120_000).nullable(),
  userActionRequired: z.boolean(),
  terminal: z.boolean(),
  reportReady: z.boolean(),
  message: z.string().trim().max(300).optional(),
  errorCode: scottyErrorCodeSchema.optional(),
  errorMessage: z.string().trim().max(500).optional(),
  acceptedAt: z.string().datetime({ offset: true }).optional(),
  updatedAt: z.string().datetime({ offset: true }),
  /** Dev/test only — never set in production responses. */
  simulatorMode: z.boolean().optional(),
});
export type ApplicationAnalysisStatus = z.infer<typeof applicationAnalysisStatusSchema>;
