/**
 * Abstract media transfer descriptor for provider submissions.
 * Raw signed URLs must not be persisted — resolve transiently at transport time.
 */
import { z } from "zod";

export const mediaTransferDescriptorSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("multipart"),
    /** Opaque application media reference — not a storage credential. */
    mediaReference: z.string().trim().min(1).max(256),
  }),
  z.object({
    type: z.literal("short_lived_url"),
    /** Transient URL reference resolved at transport time — do not persist. */
    urlReference: z.string().trim().min(1).max(2048),
    expiresAt: z.string().datetime({ offset: true }),
  }),
  z.object({
    type: z.literal("gateway_pull"),
    uploadReference: z.string().trim().min(1).max(256),
  }),
]);
export type MediaTransferDescriptor = z.infer<typeof mediaTransferDescriptorSchema>;
