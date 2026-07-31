/** Mirrors shared/scotty/games.ts for UI — keep in sync. */
export type GameSupportStatus =
  | "supported"
  | "legacy_supported"
  | "released_not_yet_supported"
  | "unknown"
  | "unsupported";

export interface GameCatalogEntry {
  canonicalGameId: string;
  title: string;
  supportStatus: GameSupportStatus;
}

export const GAME_CATALOG: GameCatalogEntry[] = [
  { canonicalGameId: "nhl-25", title: "NHL 25", supportStatus: "supported" },
  { canonicalGameId: "nhl-24", title: "NHL 24", supportStatus: "legacy_supported" },
  { canonicalGameId: "nhl-26", title: "NHL 26", supportStatus: "released_not_yet_supported" },
];

export const RELEASED_NOT_SUPPORTED_MESSAGE =
  "This title has been released but ChelCoach analysis support is still being verified.";

export function isGameAcceptableForUpload(status: GameSupportStatus): boolean {
  return status === "supported" || status === "legacy_supported";
}
