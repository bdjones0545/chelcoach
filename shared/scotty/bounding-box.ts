/**
 * Normalized bounding box for confirmation overlays (0–1 relative coordinates).
 */
import { z } from "zod";

export const boundingBoxSchema = z
  .object({
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
    width: z.number().positive().max(1),
    height: z.number().positive().max(1),
  })
  .refine((b) => b.x + b.width <= 1 + 1e-9, {
    message: "x + width must be <= 1",
  })
  .refine((b) => b.y + b.height <= 1 + 1e-9, {
    message: "y + height must be <= 1",
  });
export type BoundingBox = z.infer<typeof boundingBoxSchema>;
