/**
 * Opt-in real-provider verification.
 *
 * Requires ANTHROPIC_API_KEY. Uses a tiny synthetic JPEG fixture — never user video.
 * Does not run in CI. Never prints API keys, image payloads, or full model responses.
 *
 *   cd server && npm run verify:live-ai
 *
 * Exit 0 + "not run" when the key is missing (so local tooling stays green).
 */
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyzeExtractedGameplay } from "../src/ai/analyze";
import { isAiConfigured, aiConfig } from "../src/ai/config";
import type { ExtractionResult } from "../src/media/types";

async function main(): Promise<void> {
  if (!process.env.ANTHROPIC_API_KEY?.trim()) {
    console.log("live-ai-verify: NOT RUN (ANTHROPIC_API_KEY not set)");
    return;
  }
  if (aiConfig.provider === "fake") {
    console.log("live-ai-verify: NOT RUN (AI_PROVIDER=fake)");
    return;
  }
  if (!isAiConfigured()) {
    console.log("live-ai-verify: NOT RUN (AI not configured)");
    return;
  }

  const dir = await mkdtemp(join(tmpdir(), "chelcoach-live-ai-"));
  try {
    // Minimal JPEG (1×1) — valid container for vision APIs.
    const jpeg = Buffer.from(
      "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAn/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAGfAP/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAQUCf//EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQMBAT8Bf//EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQIBAT8Bf//Z",
      "base64",
    );
    const path = join(dir, "frame-000.jpg");
    await writeFile(path, jpeg);

    const extraction: ExtractionResult = {
      clipId: "live-verify",
      metadata: {
        durationSec: 1,
        width: 64,
        height: 64,
        fps: 30,
        codec: "h264",
        container: "mp4",
        rotationDeg: 0,
        hasVideoStream: true,
        sizeBytes: jpeg.length,
      },
      timestampsSec: [0.2],
      frameCount: 1,
      frames: [{ index: 0, timestampSec: 0.2, path, width: 64, height: 64 }],
      warnings: [],
      durationMs: 0,
      completedAt: new Date().toISOString(),
    };

    console.log(`live-ai-verify: calling model=${aiConfig.model} frames=1`);
    const result = await analyzeExtractedGameplay(extraction, {
      signal: AbortSignal.timeout(aiConfig.requestTimeoutMs),
    });

    console.log("live-ai-verify: OK");
    console.log(`  source=${result.provenance.reportSource}`);
    console.log(`  provider=${result.provenance.provider}`);
    console.log(`  model=${result.provenance.model}`);
    console.log(`  chelRating=${result.report.scorecard.chelRating}`);
    console.log(`  metrics=${result.report.scorecard.metrics.length}`);
    if (result.provenance.usage) {
      console.log(
        `  usage in=${result.provenance.usage.inputTokens ?? "?"} out=${result.provenance.usage.outputTokens ?? "?"}`,
      );
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(
    "live-ai-verify: FAILED",
    err instanceof Error ? `${err.name}: ${err.message}` : err,
  );
  process.exitCode = 1;
});
