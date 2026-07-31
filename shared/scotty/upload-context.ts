/**
 * Per-upload gameplay context snapshot (immutable for that upload).
 */
import { z } from "zod";
import { mediaClassificationSchema } from "./enums";
import { gameContextSchema } from "./game-context";
import { playerContextSchema } from "./player-context";

export const uploadGameplayContextSchema = z.object({
  gameContext: gameContextSchema,
  playerContext: playerContextSchema,
  /** User confirms they control a single player in the footage. */
  singlePlayerControl: z.boolean(),
  mediaClassification: mediaClassificationSchema.optional(),
  notes: z.string().trim().max(500).optional(),
});
export type UploadGameplayContext = z.infer<typeof uploadGameplayContextSchema>;

export const createUploadSessionRequestSchema = z.object({
  filename: z.string().trim().min(1).max(260),
  contentType: z.enum(["video/mp4", "video/quicktime"]),
  sizeBytes: z.number().int().positive(),
  clientDeclaredDurationSec: z.number().positive().max(3600).optional(),
  context: uploadGameplayContextSchema,
  /** When true, persist context fields into the user's gameplay profile defaults. */
  saveAsDefaults: z.boolean().default(false),
});
export type CreateUploadSessionRequest = z.infer<typeof createUploadSessionRequestSchema>;

export const uploadTransportSchema = z.enum(["server_stream", "supabase_resumable"]);
export type UploadTransport = z.infer<typeof uploadTransportSchema>;

export const publicUploadSessionResponseSchema = z.object({
  uploadId: z.string(),
  uploadStatus: z.string(),
  /**
   * Relative API path for streamed PUT (server_stream).
   * Empty when transport is supabase_resumable.
   */
  uploadUrl: z.string(),
  transport: uploadTransportSchema.default("server_stream"),
  /** Private gameplay bucket name (supabase_resumable). */
  bucket: z.string().optional(),
  /** Server-generated object path under the user prefix (supabase_resumable). */
  objectPath: z.string().optional(),
  /** Supabase TUS resumable endpoint (supabase_resumable). */
  resumableEndpoint: z.string().optional(),
  allowedMimeTypes: z.array(z.string()),
  maxBytes: z.number().int().positive(),
  expiresAt: z.string().datetime({ offset: true }),
  pendingExpiresAt: z.string().datetime({ offset: true }).optional(),
  retentionHours: z.number().int().positive(),
  retentionNotice: z.string(),
  gameSupportMessage: z.string().optional(),
});
export type PublicUploadSessionResponse = z.infer<typeof publicUploadSessionResponseSchema>;

export const publicUploadDetailSchema = z.object({
  uploadId: z.string(),
  uploadStatus: z.string(),
  displayFilename: z.string(),
  mimeType: z.string(),
  byteSize: z.number().int().nonnegative(),
  durationSec: z.number().positive().optional(),
  mediaClassification: mediaClassificationSchema.optional(),
  context: uploadGameplayContextSchema,
  expiresAt: z.string().datetime({ offset: true }),
  absoluteDeleteAt: z.string().datetime({ offset: true }).optional(),
  retentionHours: z.number().int().positive(),
  retentionNotice: z.string(),
  sourceVideoExpiredMessage: z.string().optional(),
  errorCode: z.string().optional(),
  errorMessage: z.string().optional(),
  createdAt: z.string().datetime({ offset: true }),
  uploadedAt: z.string().datetime({ offset: true }).optional(),
  readyAt: z.string().datetime({ offset: true }).optional(),
});
export type PublicUploadDetail = z.infer<typeof publicUploadDetailSchema>;
