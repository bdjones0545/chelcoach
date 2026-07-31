/**
 * Reusable gameplay profile preferences (not immutable identity).
 */
import { z } from "zod";
import {
  controlSchemeSchema,
  gameModeSchema,
  playerPositionSchema,
  supportedPlatformSchema,
  teamSideSchema,
} from "./enums";

export const gameplayProfileSchema = z.object({
  userId: z.string().trim().min(1).max(128),
  preferredPlatform: supportedPlatformSchema,
  consoleGeneration: z.string().trim().max(50).optional(),
  preferredControlScheme: controlSchemeSchema,
  primaryPosition: playerPositionSchema,
  commonGameMode: gameModeSchema,
  defaultIndicatorColor: z.string().trim().max(40).nullable().optional(),
  defaultTeamSide: teamSideSchema.optional(),
  lastSelectedGameId: z.string().trim().max(80).nullable().optional(),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
});
export type GameplayProfile = z.infer<typeof gameplayProfileSchema>;

/** Partial update — only provided fields are applied. */
export const gameplayProfileUpdateSchema = z
  .object({
    preferredPlatform: supportedPlatformSchema.optional(),
    consoleGeneration: z.string().trim().max(50).optional(),
    preferredControlScheme: controlSchemeSchema.optional(),
    primaryPosition: playerPositionSchema.optional(),
    commonGameMode: gameModeSchema.optional(),
    defaultIndicatorColor: z.string().trim().max(40).nullable().optional(),
    defaultTeamSide: teamSideSchema.optional(),
    lastSelectedGameId: z.string().trim().max(80).nullable().optional(),
  })
  .strict();
export type GameplayProfileUpdate = z.infer<typeof gameplayProfileUpdateSchema>;

export function defaultGameplayProfile(userId: string, nowIso: string): GameplayProfile {
  return gameplayProfileSchema.parse({
    userId,
    preferredPlatform: "unknown",
    preferredControlScheme: "unknown",
    primaryPosition: "unknown",
    commonGameMode: "unknown",
    defaultIndicatorColor: null,
    lastSelectedGameId: null,
    createdAt: nowIso,
    updatedAt: nowIso,
  });
}
