import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { jpegDimensions, planSampleTimestamps } from "./frameSampler";
import { fakeJpeg } from "./jpegFixture";

describe("frame sampler planning", () => {
  it("spreads samples across the clip, away from the edges, within bounds", () => {
    const short = planSampleTimestamps(30);
    assert.ok(short.length >= 6 && short.length <= 24);
    assert.ok(short[0]! > 0, "never the very first frame");
    assert.ok(short[short.length - 1]! < 30, "never the very last frame");
    for (let i = 1; i < short.length; i++) assert.ok(short[i]! > short[i - 1]!, "monotonic");

    const game = planSampleTimestamps(1800);
    assert.equal(game.length, 24, "a full game is capped");
    assert.ok(game[game.length - 1]! <= 1800);

    const tiny = planSampleTimestamps(1);
    assert.ok(tiny.length >= 1);
    for (const t of tiny) assert.ok(t >= 0 && t <= 1);

    assert.deepEqual(planSampleTimestamps(0), []);
    assert.deepEqual(planSampleTimestamps(Number.NaN), []);
  });

  it("honors an exact frame count for evidence frames", () => {
    const three = planSampleTimestamps(90, { minFrames: 3, maxFrames: 3 });
    assert.equal(three.length, 3);
  });
});

describe("jpeg dimensions", () => {
  it("reads width and height from the SOF marker", () => {
    assert.deepEqual(jpegDimensions(fakeJpeg(1024, 576)), { width: 1024, height: 576 });
    assert.deepEqual(jpegDimensions(fakeJpeg(1, 1, 100)), { width: 1, height: 1 });
  });

  it("returns zeros for non-JPEG bytes", () => {
    assert.deepEqual(jpegDimensions(Buffer.from("not a jpeg")), { width: 0, height: 0 });
    assert.deepEqual(jpegDimensions(Buffer.alloc(0)), { width: 0, height: 0 });
  });
});
