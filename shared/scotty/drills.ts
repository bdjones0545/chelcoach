import { z } from "zod";
import { controlInputStepSchema } from "./controls";
import { controlSchemeSchema, playerPositionSchema, supportedPlatformSchema } from "./enums";

export const MAX_PRACTICE_DRILLS = 3;

export const practiceDrillSchema = z.object({
  drillId: z.string().trim().min(1).max(128),
  name: z.string().trim().min(1).max(120),
  objective: z.string().trim().min(1).max(400),
  gameTitle: z.string().trim().min(1).max(120),
  platform: supportedPlatformSchema,
  controlScheme: controlSchemeSchema,
  position: playerPositionSchema,
  setup: z.string().trim().max(500),
  requiredMechanics: z.array(z.string().trim().max(120)).max(20),
  verifiedControlInputs: z.array(controlInputStepSchema).max(40),
  repetitionTarget: z.string().trim().max(120),
  successCriteria: z.string().trim().max(300),
  commonErrors: z.array(z.string().trim().max(200)).max(10),
  progression: z.string().trim().max(400).optional(),
});
export type PracticeDrill = z.infer<typeof practiceDrillSchema>;

export const practiceDrillListSchema = z.array(practiceDrillSchema).max(MAX_PRACTICE_DRILLS);
