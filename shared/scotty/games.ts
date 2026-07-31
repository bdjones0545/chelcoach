/**
 * Canonical NHL title catalog for upload selection.
 * Newest year ≠ automatically production-supported.
 */
import { z } from "zod";
import { gameSupportStatusSchema, type GameSupportStatus } from "./enums";
import { gameContextSchema, type GameContext } from "./game-context";

export const gameCatalogEntrySchema = z.object({
  canonicalGameId: z.string().trim().min(1).max(80),
  title: z.string().trim().min(1).max(120),
  supportStatus: gameSupportStatusSchema,
  /** Optional marketing year label — not used for auto-selection. */
  releaseYear: z.number().int().min(1990).max(2100).optional(),
});
export type GameCatalogEntry = z.infer<typeof gameCatalogEntrySchema>;

/** Curated list — extend as titles are verified. */
export const GAME_CATALOG: readonly GameCatalogEntry[] = [
  {
    canonicalGameId: "nhl-25",
    title: "NHL 25",
    supportStatus: "supported",
    releaseYear: 2024,
  },
  {
    canonicalGameId: "nhl-24",
    title: "NHL 24",
    supportStatus: "legacy_supported",
    releaseYear: 2023,
  },
  {
    canonicalGameId: "nhl-26",
    title: "NHL 26",
    supportStatus: "released_not_yet_supported",
    releaseYear: 2025,
  },
] as const;

export const RELEASED_NOT_SUPPORTED_MESSAGE =
  "This title has been released but ChelCoach analysis support is still being verified.";

export function findGameById(canonicalGameId: string): GameCatalogEntry | undefined {
  return GAME_CATALOG.find((g) => g.canonicalGameId === canonicalGameId);
}

export function isGameAcceptableForUpload(status: GameSupportStatus): boolean {
  return status === "supported" || status === "legacy_supported";
}

export function buildGameContextFromSelection(
  canonicalGameId: string,
  overrides: Partial<GameContext> = {},
): GameContext {
  const entry = findGameById(canonicalGameId);
  if (!entry) {
    return gameContextSchema.parse({
      selectedGameTitle: overrides.selectedGameTitle ?? "Unknown title",
      canonicalGameId,
      supportStatus: "unknown",
      mismatchState: "unsupported_selection",
      ...overrides,
    });
  }
  return gameContextSchema.parse({
    selectedGameTitle: entry.title,
    canonicalGameId: entry.canonicalGameId,
    supportStatus: entry.supportStatus,
    mismatchState: isGameAcceptableForUpload(entry.supportStatus) ? "none" : "unsupported_selection",
    ...overrides,
  });
}
