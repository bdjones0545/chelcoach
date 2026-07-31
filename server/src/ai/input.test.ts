import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { buildAiAnalysisInput, formatTimestamp, releaseAiInputBuffers } from "./input";
import { PROMPT_VERSION, RUBRIC_VERSION } from "./versions";
import type { ExtractionResult } from "../media/types";
import { AiAnalysisError } from "./errors";

const dirs: string[] = [];

afterEach(async () => {
  while (dirs.length) {
    const d = dirs.pop();
    if (d) await rm(d, { recursive: true, force: true });
  }
});

async function fixtureExtraction(opts?: {
  frames?: Array<{ ts: number; bytes: Buffer; skipPath?: boolean }>;
}): Promise<ExtractionResult> {
  const dir = await mkdtemp(join(tmpdir(), "chelcoach-ai-in-"));
  dirs.push(dir);
  const framesSpec =
    opts?.frames ??
    [
      { ts: 1.5, bytes: Buffer.from([0xff, 0xd8, 0xff, 1, 2, 3]) },
      { ts: 0.5, bytes: Buffer.from([0xff, 0xd8, 0xff, 4, 5, 6]) },
      { ts: 2.5, bytes: Buffer.from([0xff, 0xd8, 0xff, 7, 8, 9]) },
    ];

  const frames = [];
  for (let i = 0; i < framesSpec.length; i++) {
    const spec = framesSpec[i]!;
    const path = join(dir, `f${i}.jpg`);
    if (!spec.skipPath) await writeFile(path, spec.bytes);
    frames.push({
      index: i,
      timestampSec: spec.ts,
      path: spec.skipPath ? "" : path,
      width: 320,
      height: 180,
    });
  }

  return {
    clipId: "clip-1",
    metadata: {
      durationSec: 3,
      width: 640,
      height: 360,
      fps: 30,
      codec: "h264",
      container: "mp4",
      rotationDeg: 0,
      hasVideoStream: true,
      sizeBytes: 1000,
    },
    timestampsSec: framesSpec.map((f) => f.ts),
    frameCount: frames.length,
    frames,
    warnings: [],
    durationMs: 10,
    completedAt: new Date().toISOString(),
  };
}

describe("buildAiAnalysisInput", () => {
  it("preserves chronological frame order and timestamp association", async () => {
    const extraction = await fixtureExtraction();
    const input = await buildAiAnalysisInput(extraction);
    assert.deepEqual(
      input.frames.map((f) => f.timestampSec),
      [0.5, 1.5, 2.5],
    );
    assert.deepEqual(input.timestampsSec, [0.5, 1.5, 2.5]);
    assert.ok(input.frames.every((f) => f.mediaType === "image/jpeg"));
  });

  it("caps frame count", async () => {
    const extraction = await fixtureExtraction();
    const input = await buildAiAnalysisInput(extraction, { maxFrames: 2 });
    assert.equal(input.frames.length, 2);
    assert.deepEqual(input.timestampsSec, [0.5, 1.5]);
  });

  it("enforces total image size cap", async () => {
    const extraction = await fixtureExtraction({
      frames: [
        { ts: 0, bytes: Buffer.alloc(100, 1) },
        { ts: 1, bytes: Buffer.alloc(100, 2) },
      ],
    });
    await assert.rejects(
      () => buildAiAnalysisInput(extraction, { maxTotalImageBytes: 150 }),
      (err: unknown) => err instanceof AiAnalysisError && err.internalCode === "AI_REQUEST_TOO_LARGE",
    );
  });

  it("rejects unreadable frames", async () => {
    const extraction = await fixtureExtraction({
      frames: [{ ts: 0, bytes: Buffer.from([1]), skipPath: true }],
    });
    // path empty → filtered out → no frames
    await assert.rejects(
      () => buildAiAnalysisInput(extraction),
      (err: unknown) => err instanceof AiAnalysisError && err.internalCode === "AI_FRAME_UNREADABLE",
    );
  });

  it("includes prompt/rubric/contract versions", async () => {
    const extraction = await fixtureExtraction();
    const input = await buildAiAnalysisInput(extraction);
    assert.equal(input.promptVersion, PROMPT_VERSION);
    assert.equal(input.rubricVersion, RUBRIC_VERSION);
    assert.equal(input.contractVersion, "1");
  });

  it("does not expose filesystem paths on the validated input", async () => {
    const extraction = await fixtureExtraction();
    const input = await buildAiAnalysisInput(extraction);
    const serialized = JSON.stringify({
      clipId: input.clipId,
      timestampsSec: input.timestampsSec,
      contractVersion: input.contractVersion,
    });
    assert.equal(serialized.includes(tmpdir()), false);
    assert.equal("path" in input.frames[0]!, false);
    releaseAiInputBuffers(input);
    assert.equal(input.frames[0]!.bytes.length, 0);
  });

  it("formats timestamps as m:ss", () => {
    assert.equal(formatTimestamp(62), "1:02");
    assert.equal(formatTimestamp(8.9), "0:08");
  });
});
