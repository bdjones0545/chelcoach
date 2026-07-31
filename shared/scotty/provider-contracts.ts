/**
 * Provider-boundary contracts (Step 4) — submissions, receipts, health, callbacks.
 */
import { z } from "zod";
import { DEFAULT_REQUESTED_CAPABILITIES, requestedCapabilitiesSchema } from "./analysis-request";
import { analysisProviderSchema, mediaClassificationSchema, scottyJobStatusSchema } from "./enums";
import { effectivePlayerContextSchema } from "./effective-player";
import { gameContextSchema } from "./game-context";
import { mediaTransferDescriptorSchema } from "./media-transfer";
import { playerContextSchema } from "./player-context";
import { trustedMediaMetadataSchema } from "./upload";
import { SCOTTY_CONTRACT_VERSION, scottyContractVersionSchema } from "./version";
import { scottyErrorCodeSchema } from "./errors";

export const scottyAnalysisSubmissionSchema = z.object({
  contractVersion: scottyContractVersionSchema.default(SCOTTY_CONTRACT_VERSION),
  requestId: z.string().trim().min(1).max(128),
  idempotencyKey: z.string().trim().min(1).max(128),
  uploadId: z.string().trim().min(1).max(128),
  /** Pseudonymous owner reference — never email/gamertag. */
  ownerReference: z.string().trim().min(1).max(128),
  gameContext: gameContextSchema,
  /** Platform/control/mode from upload snapshot. */
  playerContext: playerContextSchema,
  effectivePlayer: effectivePlayerContextSchema,
  mediaMetadata: trustedMediaMetadataSchema,
  mediaClassification: mediaClassificationSchema,
  capabilities: requestedCapabilitiesSchema.default(DEFAULT_REQUESTED_CAPABILITIES),
  mediaTransfer: mediaTransferDescriptorSchema,
  retentionExpiresAt: z.string().datetime({ offset: true }),
  createdAt: z.string().datetime({ offset: true }),
});
export type ScottyAnalysisSubmission = z.infer<typeof scottyAnalysisSubmissionSchema>;

export const scottyProviderJobReceiptSchema = z.object({
  contractVersion: scottyContractVersionSchema.default(SCOTTY_CONTRACT_VERSION),
  provider: analysisProviderSchema,
  externalJobId: z.string().trim().min(1).max(128),
  applicationRequestId: z.string().trim().min(1).max(128),
  idempotencyKey: z.string().trim().min(1).max(128),
  acceptedAt: z.string().datetime({ offset: true }),
  status: scottyJobStatusSchema,
  /** Suggested next poll delay in ms — advisory only. */
  pollAfterMs: z.number().int().positive().max(120_000).optional(),
  /** Internal-only trace — strip before frontend responses. */
  providerTraceId: z.string().trim().max(128).optional(),
});
export type ScottyProviderJobReceipt = z.infer<typeof scottyProviderJobReceiptSchema>;

export const scottyJobLookupSchema = z.object({
  externalJobId: z.string().trim().min(1).max(128),
  applicationRequestId: z.string().trim().min(1).max(128).optional(),
});
export type ScottyJobLookup = z.infer<typeof scottyJobLookupSchema>;

export const scottyReportLookupSchema = z.object({
  externalJobId: z.string().trim().min(1).max(128),
  applicationRequestId: z.string().trim().min(1).max(128).optional(),
});
export type ScottyReportLookup = z.infer<typeof scottyReportLookupSchema>;

export const scottyPlayerConfirmationSubmissionSchema = z.object({
  externalJobId: z.string().trim().min(1).max(128),
  applicationRequestId: z.string().trim().min(1).max(128),
  selectedCandidateId: z.string().trim().min(1).max(128),
  confirmedAt: z.string().datetime({ offset: true }),
});
export type ScottyPlayerConfirmationSubmission = z.infer<
  typeof scottyPlayerConfirmationSubmissionSchema
>;

export const scottyCancelRequestSchema = z.object({
  externalJobId: z.string().trim().min(1).max(128),
  applicationRequestId: z.string().trim().min(1).max(128),
  reason: z.string().trim().max(200).optional(),
});
export type ScottyCancelRequest = z.infer<typeof scottyCancelRequestSchema>;

export const scottyCancelResponseSchema = z.object({
  externalJobId: z.string().trim().min(1).max(128),
  status: z.literal("cancelled"),
  cancelledAt: z.string().datetime({ offset: true }),
});
export type ScottyCancelResponse = z.infer<typeof scottyCancelResponseSchema>;

export const providerHealthStatusSchema = z.enum([
  "healthy",
  "degraded",
  "unavailable",
  "misconfigured",
  "disabled",
  "unknown",
]);
export type ProviderHealthStatus = z.infer<typeof providerHealthStatusSchema>;

export const scottyProviderHealthSchema = z.object({
  provider: analysisProviderSchema,
  configured: z.boolean(),
  reachable: z.boolean().optional(),
  contractCompatible: z.boolean(),
  status: providerHealthStatusSchema,
  checkedAt: z.string().datetime({ offset: true }),
  message: z.string().trim().max(300).optional(),
});
export type ScottyProviderHealth = z.infer<typeof scottyProviderHealthSchema>;

export const providerErrorCategorySchema = z.enum([
  "configuration",
  "authentication",
  "authorization",
  "validation",
  "rate_limit",
  "timeout",
  "network",
  "provider_unavailable",
  "contract_mismatch",
  "invalid_response",
  "permanent_failure",
]);
export type ProviderErrorCategory = z.infer<typeof providerErrorCategorySchema>;

export const callbackEventTypeSchema = z.enum([
  "job_accepted",
  "status_changed",
  "player_confirmation_required",
  "completed",
  "failed",
  "cancelled",
]);
export type CallbackEventType = z.infer<typeof callbackEventTypeSchema>;

export const scottyCallbackEventSchema = z.object({
  eventId: z.string().trim().min(1).max(128),
  eventType: callbackEventTypeSchema,
  contractVersion: scottyContractVersionSchema.default(SCOTTY_CONTRACT_VERSION),
  externalJobId: z.string().trim().min(1).max(128),
  applicationRequestId: z.string().trim().min(1).max(128),
  status: scottyJobStatusSchema,
  occurredAt: z.string().datetime({ offset: true }),
  sequenceNumber: z.number().int().nonnegative(),
  payload: z.record(z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
});
export type ScottyCallbackEvent = z.infer<typeof scottyCallbackEventSchema>;

/** Safe application-facing submission result (no secrets / trace IDs). */
export const applicationAnalysisSubmissionResultSchema = z.object({
  applicationRequestId: z.string().trim().min(1).max(128),
  uploadId: z.string().trim().min(1).max(128),
  provider: analysisProviderSchema,
  status: scottyJobStatusSchema,
  acceptedAt: z.string().datetime({ offset: true }),
  reused: z.boolean(),
  nextAction: z.enum(["poll_later", "wait", "none"]),
  pollAfterMs: z.number().int().positive().optional(),
  errorCode: scottyErrorCodeSchema.optional(),
  errorMessage: z.string().trim().max(500).optional(),
});
export type ApplicationAnalysisSubmissionResult = z.infer<
  typeof applicationAnalysisSubmissionResultSchema
>;

export const analysisSubmitRequestSchema = z.object({
  /** Capabilities are server-controlled; client may omit (defaults applied). */
  capabilities: requestedCapabilitiesSchema.optional(),
  clientRequestId: z.string().trim().min(1).max(128).optional(),
});
export type AnalysisSubmitRequest = z.infer<typeof analysisSubmitRequestSchema>;
