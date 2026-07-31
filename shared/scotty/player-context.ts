import { z } from "zod";
import {
  controlSchemeSchema,
  gameModeSchema,
  playerPositionSchema,
  supportedPlatformSchema,
  teamSideSchema,
} from "./enums";

export const playerContextSchema = z.object({
  platform: supportedPlatformSchema,
  consoleGeneration: z.string().trim().max(50).optional(),
  controlScheme: controlSchemeSchema,
  position: playerPositionSchema,
  gameMode: gameModeSchema,
  jerseyNumber: z.number().int().min(0).max(99).nullable().optional(),
  indicatorColor: z.string().trim().max(40).nullable().optional(),
  teamSide: teamSideSchema.optional(),
});
export type PlayerContext = z.infer<typeof playerContextSchema>;

/** Soft validation — goalie scheme with skater position is flagged, not silently accepted. */
export function validatePlatformControlCombination(
  ctx: PlayerContext,
): { ok: true } | { ok: false; code: "INVALID_PLATFORM_CONTROL_COMBINATION"; message: string } {
  if (ctx.controlScheme === "goalie" && ctx.position !== "G" && ctx.position !== "unknown") {
    return {
      ok: false,
      code: "INVALID_PLATFORM_CONTROL_COMBINATION",
      message: "Goalie control scheme requires position G (or unknown).",
    };
  }
  // Platform support is title-specific; unknown platform with a concrete scheme is allowed
  // but concrete platform + unknown scheme is fine. No Xbox/PlayStation cross-mixing here.
  return { ok: true };
}
