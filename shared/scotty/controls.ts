import { z } from "zod";
import {
  controlSchemeSchema,
  evidenceConfidenceLabelSchema,
  supportedPlatformSchema,
} from "./enums";

export const inputBehaviorSchema = z.enum(["tap", "hold", "motion", "combo", "unknown"]);
export type InputBehavior = z.infer<typeof inputBehaviorSchema>;

export const controlInputStepSchema = z.object({
  order: z.number().int().nonnegative().max(40),
  input: z.string().trim().min(1).max(80),
  behavior: inputBehaviorSchema,
  note: z.string().trim().max(200).optional(),
});
export type ControlInputStep = z.infer<typeof controlInputStepSchema>;

/**
 * Platform-specific execution guidance.
 * Normal reports contain only the user's selected platform + scheme.
 * Xbox and PlayStation inputs must not appear together unless comparison=true.
 */
export const controlGuidanceSchema = z
  .object({
    gameTitle: z.string().trim().min(1).max(120),
    gameVersion: z.string().trim().max(40).optional(),
    platform: supportedPlatformSchema,
    controlScheme: controlSchemeSchema,
    canonicalMechanic: z.string().trim().min(1).max(120),
    inputSequence: z.array(controlInputStepSchema).min(1).max(40),
    timingCue: z.string().trim().max(300).optional(),
    verificationStatus: z.enum(["verified", "provisional", "unverified"]),
    verifiedAt: z.string().datetime({ offset: true }).optional(),
    sourceConfidence: evidenceConfidenceLabelSchema,
    /** When true, may include cross-platform comparison notes (not mixed button pads). */
    platformComparison: z.boolean().default(false),
    comparisonNotes: z.string().trim().max(500).optional(),
  })
  .superRefine((val, ctx) => {
    if (val.platformComparison) return;
    const joined = val.inputSequence.map((s) => s.input.toLowerCase()).join(" ");
    const hasXbox =
      /\b(a|b|x|y|lb|rb|lt|rt|xbox|view|menu)\b/.test(joined) ||
      joined.includes("xbox");
    const hasPlayStation =
      /\b(cross|circle|square|triangle|l1|r1|l2|r2|options|touchpad|playstation|ps[45]?)\b/.test(
        joined,
      ) || joined.includes("playstation");
    const xboxPlatform = val.platform.startsWith("xbox");
    const psPlatform = val.platform.startsWith("playstation");
    if (xboxPlatform && hasPlayStation) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "PlayStation controls cannot appear in an Xbox execution object",
        path: ["inputSequence"],
      });
    }
    if (psPlatform && hasXbox) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Xbox controls cannot appear in a PlayStation execution object",
        path: ["inputSequence"],
      });
    }
  });
export type ControlGuidance = z.infer<typeof controlGuidanceSchema>;
