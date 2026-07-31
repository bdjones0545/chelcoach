/**
 * Durable media-inspection job contracts (Step 10.1D).
 * Separate from upload status and analysis-job status.
 */
import { z } from "zod";
import { mediaClassificationSchema } from "./enums";

export const mediaInspectionStatusSchema = z.enum([
  "queued",
  "claimed",
  "downloading",
  "inspecting",
  "validating",
  "completed",
  "failed",
  "cancelled",
  "expired",
]);
export type MediaInspectionStatus = z.infer<typeof mediaInspectionStatusSchema>;

/** Safe public inspection summary — no worker/object internals. */
export const publicInspectionSummarySchema = z.object({
  status: mediaInspectionStatusSchema,
  message: z.string().max(300),
  retryable: z.boolean(),
  pollAfterMs: z.number().int().positive().max(30_000).optional(),
});
export type PublicInspectionSummary = z.infer<typeof publicInspectionSummarySchema>;

export function publicInspectionMessage(status: MediaInspectionStatus): string {
  switch (status) {
    case "queued":
      return "Your gameplay video is waiting for verification.";
    case "claimed":
    case "downloading":
      return "Waiting for verification.";
    case "inspecting":
      return "Inspecting gameplay video.";
    case "validating":
      return "Validating media.";
    case "completed":
      return "Ready for player identification.";
    case "failed":
      return "We couldn't verify this video.";
    case "cancelled":
      return "Verification was cancelled.";
    case "expired":
      return "Verification expired. Please upload again.";
    default:
      return "Verifying gameplay video.";
  }
}

export function pollAfterMsForInspection(status: MediaInspectionStatus): number | null {
  if (
    status === "completed" ||
    status === "failed" ||
    status === "cancelled" ||
    status === "expired"
  ) {
    return null;
  }
  if (status === "queued") return 2000;
  if (status === "claimed" || status === "downloading") return 2000;
  return 1500;
}

export const mediaInspectionTrustedResultSchema = z.object({
  durationSec: z.number().positive(),
  byteSize: z.number().int().nonnegative(),
  mimeType: z.string(),
  videoCodec: z.string().optional(),
  audioCodec: z.string().optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  frameRate: z.number().positive().optional(),
  rotation: z.number().int().optional(),
  mediaClassification: mediaClassificationSchema,
  objectFingerprint: z.string(),
  inspectedAt: z.string().datetime({ offset: true }),
});
export type MediaInspectionTrustedResult = z.infer<typeof mediaInspectionTrustedResultSchema>;
