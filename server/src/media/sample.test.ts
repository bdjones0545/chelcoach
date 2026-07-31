import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { sampleTimestamps } from "./sample";

describe("sampleTimestamps", () => {
  it("is deterministic for the same duration", () => {
    const a = sampleTimestamps(10, { maxFrames: 8, edgeSkipFraction: 0.05 });
    const b = sampleTimestamps(10, { maxFrames: 8, edgeSkipFraction: 0.05 });
    assert.deepEqual(a, b);
  });

  it("caps frame count", () => {
    const ts = sampleTimestamps(120, { maxFrames: 5, edgeSkipFraction: 0.05 });
    assert.ok(ts.length <= 5);
    assert.ok(ts.length >= 1);
  });

  it("handles very short clips with a single midpoint", () => {
    const ts = sampleTimestamps(0.1, { maxFrames: 12 });
    assert.equal(ts.length, 1);
    assert.ok(ts[0] > 0 && ts[0] < 0.1);
  });

  it("avoids duplicate timestamps", () => {
    const ts = sampleTimestamps(2, { maxFrames: 12, edgeSkipFraction: 0.05 });
    assert.equal(new Set(ts.map((t) => t.toFixed(3))).size, ts.length);
  });

  it("rejects non-positive duration", () => {
    assert.throws(() => sampleTimestamps(0), /positive/);
    assert.throws(() => sampleTimestamps(-1), /positive/);
  });
});
