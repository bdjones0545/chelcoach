/**
 * Real-ffmpeg integration tests. Skipped cleanly when binaries are missing.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { mediaBinariesAvailable } from "./binaries";
import { runExtractionPipeline } from "./pipeline";
import { getStorage, resetStorageForTests } from "../storage";
import { createClip, markUploaded, resetStoreForTests } from "../store";

const hasFfmpeg = mediaBinariesAvailable();

describe("runExtractionPipeline (ffmpeg)", { skip: !hasFfmpeg }, () => {
  let fixtureBytes: Buffer;

  before(async () => {
    const dir = await mkdtemp(join(tmpdir(), "chelcoach-fix-"));
    const mp4 = join(dir, "clip.mp4");
    const gen = spawnSync(
      "ffmpeg",
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "lavfi",
        "-i",
        "color=c=green:s=640x360:d=2",
        "-frames:v",
        "48",
        "-y",
        mp4,
      ],
      { encoding: "utf8" },
    );
    assert.equal(gen.status, 0, gen.stderr);
    fixtureBytes = await readFile(mp4);
    await rm(dir, { recursive: true, force: true });
  });

  after(() => {
    resetStoreForTests();
    resetStorageForTests();
  });

  it("extracts a bounded frame set from a valid short video", async () => {
    resetStoreForTests();
    resetStorageForTests();
    process.env.STORAGE_BACKEND = "memory";

    const clip = createClip({
      filename: "game.mp4",
      contentType: "video/mp4",
      sizeBytes: fixtureBytes.length,
    });
    await getStorage().put(clip.storageKey, fixtureBytes, "video/mp4");
    markUploaded(clip.id, fixtureBytes.length);

    const stages: string[] = [];
    const result = await runExtractionPipeline({
      clipId: clip.id,
      storageKey: clip.storageKey,
      sizeBytes: fixtureBytes.length,
      onStage: (stage) => stages.push(stage),
    });

    assert.ok(result.frameCount >= 1);
    assert.ok(result.frameCount <= 12);
    assert.equal(result.timestampsSec.length, result.frameCount);
    assert.ok(result.metadata.hasVideoStream);
    assert.ok(result.metadata.durationSec > 0);
    assert.ok(stages.includes("inspecting_video"));
    assert.ok(stages.includes("extracting_frames"));
    assert.ok(stages.includes("finalizing"));
    // Paths cleared after cleanup — no public serving of temp frames.
    assert.ok(result.frames.every((f) => f.path === ""));
  });
});

if (!hasFfmpeg) {
  describe("runExtractionPipeline (ffmpeg skipped)", () => {
    it("records intentional skip when binaries are unavailable", () => {
      assert.equal(hasFfmpeg, false);
    });
  });
}
