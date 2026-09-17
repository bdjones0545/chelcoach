import { describe, expect, it } from "vitest";
import { GAME_CATALOG as SHARED_CATALOG } from "../../shared/scotty/games";
import { GAME_CATALOG, isGameAcceptableForUpload } from "./gameCatalog";

describe("game catalog", () => {
  it("mirrors shared/scotty/games.ts exactly (id, title, status, order)", () => {
    expect(GAME_CATALOG).toEqual(
      SHARED_CATALOG.map(({ canonicalGameId, title, supportStatus }) => ({ canonicalGameId, title, supportStatus })),
    );
  });

  it("offers the current EA title first and accepts it for upload", () => {
    expect(GAME_CATALOG[0]).toMatchObject({ canonicalGameId: "nhl-27", title: "NHL 27" });
    expect(isGameAcceptableForUpload(GAME_CATALOG[0].supportStatus)).toBe(true);
  });
});
