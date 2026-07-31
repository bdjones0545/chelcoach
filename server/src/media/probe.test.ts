import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mediaConfig } from "./config";
import { MediaProcessingError } from "./errors";
import { validateMetadata } from "./probe";
import type { VideoMetadata } from "./types";

function meta(partial: Partial<VideoMetadata> = {}): VideoMetadata {
  return {
    durationSec: 10,
    width: 1280,
    height: 720,
    fps: 30,
    codec: "h264",
    container: "mp4",
    rotationDeg: 0,
    hasVideoStream: true,
    sizeBytes: 1000,
    ...partial,
  };
}

describe("validateMetadata", () => {
  it("accepts valid short video metadata", () => {
    assert.doesNotThrow(() => validateMetadata(meta()));
  });

  it("rejects missing video stream", () => {
    assert.throws(
      () => validateMetadata(meta({ hasVideoStream: false })),
      (err: unknown) => err instanceof MediaProcessingError && err.internalCode === "NO_VIDEO_STREAM",
    );
  });

  it("rejects invalid dimensions", () => {
    assert.throws(
      () => validateMetadata(meta({ width: 0 })),
      (err: unknown) => err instanceof MediaProcessingError && err.internalCode === "INVALID_VIDEO_METADATA",
    );
  });

  it("rejects videos that are too long", () => {
    assert.throws(
      () => validateMetadata(meta({ durationSec: mediaConfig.maxDurationSec + 1 })),
      (err: unknown) => err instanceof MediaProcessingError && err.internalCode === "VIDEO_TOO_LONG",
    );
  });

  it("rejects excessive pixel count", () => {
    assert.throws(
      () => validateMetadata(meta({ width: 8000, height: 8000 })),
      (err: unknown) => err instanceof MediaProcessingError && err.internalCode === "VIDEO_TOO_LARGE",
    );
  });
});
