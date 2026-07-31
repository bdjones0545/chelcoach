import { z } from "zod";
import { controlGuidanceSchema } from "./controls";
import { evidenceConfidenceLabelSchema } from "./enums";

export const faceoffAnalysisSchema = z.object({
  faceoffCount: z.number().int().nonnegative().max(200),
  wins: z.number().int().nonnegative().max(200),
  losses: z.number().int().nonnegative().max(200),
  /** Present only when faceoffCount > 0. */
  winPercentage: z.number().min(0).max(100).optional(),
  detectedTechniques: z.array(z.string().trim().max(120)).max(20),
  timingAssessment: z.string().trim().max(400).optional(),
  counterSelection: z.string().trim().max(400).optional(),
  postDrawResponsibility: z.string().trim().max(400).optional(),
  possessionResult: z.string().trim().max(400).optional(),
  strengths: z.array(z.string().trim().max(200)).max(10),
  improvements: z.array(z.string().trim().max(200)).max(10),
  controlGuidance: controlGuidanceSchema.optional(),
  practiceDrillId: z.string().trim().max(128).optional(),
  confidence: evidenceConfidenceLabelSchema,
}).superRefine((val, ctx) => {
  if (val.wins + val.losses > val.faceoffCount) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "wins + losses cannot exceed faceoffCount",
      path: ["faceoffCount"],
    });
  }
  if (val.faceoffCount > 0 && val.winPercentage === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "winPercentage required when faceoffCount > 0",
      path: ["winPercentage"],
    });
  }
  if (val.faceoffCount === 0 && val.winPercentage !== undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "omit winPercentage when faceoffCount is 0",
      path: ["winPercentage"],
    });
  }
});
export type FaceoffAnalysis = z.infer<typeof faceoffAnalysisSchema>;
