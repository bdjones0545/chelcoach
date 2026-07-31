import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";
import { mediaBinariesAvailable, resetMediaBinariesCache, resolveMediaBinaries } from "./binaries";
import { MediaProcessingError } from "./errors";

describe("resolveMediaBinaries", () => {
  const prevFfmpeg = process.env.FFMPEG_PATH;
  const prevFfprobe = process.env.FFPROBE_PATH;

  beforeEach(() => {
    resetMediaBinariesCache();
    delete process.env.FFMPEG_PATH;
    delete process.env.FFPROBE_PATH;
  });

  afterEach(() => {
    resetMediaBinariesCache();
    if (prevFfmpeg === undefined) delete process.env.FFMPEG_PATH;
    else process.env.FFMPEG_PATH = prevFfmpeg;
    if (prevFfprobe === undefined) delete process.env.FFPROBE_PATH;
    else process.env.FFPROBE_PATH = prevFfprobe;
  });

  it("resolves system binaries when available", () => {
    if (!mediaBinariesAvailable()) {
      console.log("  ↷ skip — ffmpeg not installed");
      return;
    }
    const bins = resolveMediaBinaries();
    assert.ok(bins.ffmpeg.includes("ffmpeg"));
    assert.ok(bins.ffprobe.includes("ffprobe"));
  });

  it("throws FFMPEG_UNAVAILABLE for bogus explicit paths", () => {
    process.env.FFMPEG_PATH = "/nonexistent/ffmpeg-binary";
    process.env.FFPROBE_PATH = "/nonexistent/ffprobe-binary";
    assert.throws(
      () => resolveMediaBinaries(),
      (err: unknown) => err instanceof MediaProcessingError && err.internalCode === "FFMPEG_UNAVAILABLE",
    );
  });
});
