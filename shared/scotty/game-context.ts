import { z } from "zod";
import { gameSupportStatusSchema } from "./enums";

export const gameMismatchStateSchema = z.enum([
  "none",
  "user_selected_differs_from_detected",
  "version_unknown",
  "unsupported_selection",
]);
export type GameMismatchState = z.infer<typeof gameMismatchStateSchema>;

export const gameContextSchema = z.object({
  /** User-selected display title (e.g. "NHL 25"). */
  selectedGameTitle: z.string().trim().min(1).max(120),
  /** Canonical ID used by support matrices (e.g. "nhl-25"). */
  canonicalGameId: z.string().trim().min(1).max(80),
  detectedGameTitle: z.string().trim().max(120).optional(),
  gameVersion: z.string().trim().max(40).optional(),
  patchOrTunerVersion: z.string().trim().max(40).optional(),
  supportStatus: gameSupportStatusSchema,
  mismatchState: gameMismatchStateSchema.default("none"),
});
export type GameContext = z.infer<typeof gameContextSchema>;
