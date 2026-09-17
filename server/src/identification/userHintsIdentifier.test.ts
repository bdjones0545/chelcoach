import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { identifierReadiness, resolveIdentifierMode } from "./claudeVisionIdentifier";
import { USER_HINTS_CONFIDENCE, UserHintsControlledPlayerIdentifier } from "./userHintsIdentifier";
import { getPlayerIdentityConfidenceThreshold } from "../retention/policy";

const frame = (timestampSec: number) => ({ timestampSec, mimeType: "image/jpeg" as const, width: 1280, height: 720, bytes: Buffer.alloc(8) });

const input = (frames = [frame(4), frame(20), frame(36)]) => ({
  uploadId: "up_1",
  ownerId: "owner_1",
  gameContext: { selectedGameTitle: "NHL 27", canonicalGameId: "nhl-27", supportStatus: "supported" as const, mismatchState: "none" as const },
  playerContext: { platform: "xbox_series" as const, controlScheme: "skill_stick" as const, position: "C" as const, gameMode: "eashl" as const, jerseyNumber: 17, indicatorColor: "Blue", teamSide: "home" as const },
  mediaMetadata: { durationSec: 40, width: 1280, height: 720, mimeType: "video/mp4", byteSize: 1000, mediaClassification: "short_clip" as const } as never,
  frames,
});

describe("user_hints identifier", () => {
  it("turns the upload-screen hints into one candidate on a real middle frame and always asks for confirmation", async () => {
    const result = await new UserHintsControlledPlayerIdentifier().identify(input());
    assert.equal(result.provider, "user_hints");
    assert.equal(result.detected, false, "it never claims to have seen the skater");
    assert.equal(result.confirmationRequired, true);
    assert.ok(result.confidence < getPlayerIdentityConfidenceThreshold(), "below the auto-accept threshold by construction");
    assert.equal(result.confidence, USER_HINTS_CONFIDENCE);
    assert.equal(result.candidates.length, 1);
    assert.equal(result.candidates[0]!.timestampSec, 20, "middle frame, not the faceoff");
    assert.deepEqual(result.evidenceTimestampsSec, [20]);
    assert.match(result.candidates[0]!.displayLabel, /C, #17, blue indicator, home side/);
    assert.equal(result.candidates[0]!.indicatorColor, "blue");
    assert.equal(result.position, "C");
    assert.ok(result.uncertainties.some((u) => /No visual identification was run/.test(u)));
  });

  it("still produces a confirmable candidate with sparse hints and no frames", async () => {
    const sparse = input([]);
    sparse.playerContext = { platform: "playstation_5", controlScheme: "skill_stick", position: "LW", gameMode: "world_of_chel" } as never;
    const result = await new UserHintsControlledPlayerIdentifier().identify(sparse);
    assert.equal(result.candidates.length, 1);
    assert.equal(result.candidates[0]!.timestampSec, 1);
    assert.equal(result.jerseyNumber, null);
    assert.equal(result.teamSide, "unknown");
    assert.match(result.candidates[0]!.displayLabel, /LW/);
  });
});

describe("identifier mode + readiness", () => {
  it("production without an Anthropic key uses user_hints; with one, claude_vision; an explicit setting wins", () => {
    assert.equal(resolveIdentifierMode({ NODE_ENV: "production" }), "user_hints");
    assert.equal(resolveIdentifierMode({ NODE_ENV: "production", ANTHROPIC_API_KEY: "sk-ant-" + "x".repeat(30) }), "claude_vision");
    assert.equal(resolveIdentifierMode({ NODE_ENV: "production", CHELCOACH_PLAYER_IDENTIFIER: "user_hints", ANTHROPIC_API_KEY: "sk-ant-" + "x".repeat(30) }), "user_hints");
    assert.equal(resolveIdentifierMode({ NODE_ENV: "development" }), "fixture");
  });

  it("readiness refuses a vision identifier without its key and a fixture in production", () => {
    assert.deepEqual(identifierReadiness({ NODE_ENV: "production" }), { mode: "user_hints", ready: true });
    assert.deepEqual(identifierReadiness({ NODE_ENV: "production", CHELCOACH_PLAYER_IDENTIFIER: "claude_vision" }), {
      mode: "claude_vision",
      ready: false,
      reason: "IDENTIFIER_MODEL_KEY_MISSING",
    });
    assert.deepEqual(identifierReadiness({ NODE_ENV: "production", CHELCOACH_PLAYER_IDENTIFIER: "fixture" }), {
      mode: "fixture",
      ready: false,
      reason: "IDENTIFIER_FIXTURE_IN_PRODUCTION",
    });
    assert.equal(identifierReadiness({ NODE_ENV: "test" }).ready, true);
  });
});
