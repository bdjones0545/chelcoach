import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { analyzeExtractedGameplay } from "./analyze";
import { AiAnalysisError } from "./errors";
import { FakeGameplayAnalysisProvider } from "./fakeProvider";
import { setAnalysisProviderForTests } from "./provider";
import { withAiRetries } from "./retry";
import { validateAnalysisReport } from "./validateReport";
import { sampleReport } from "../data/sampleReport";
import type { ExtractionResult } from "../media/types";

const dirs: string[] = [];

beforeEach(() => {
  setAnalysisProviderForTests(undefined);
});

afterEach(async () => {
  setAnalysisProviderForTests(undefined);
  while (dirs.length) {
    const d = dirs.pop();
    if (d) await rm(d, { recursive: true, force: true });
  }
});

async function extraction(): Promise<ExtractionResult> {
  const dir = await mkdtemp(join(tmpdir(), "chelcoach-ai-an-"));
  dirs.push(dir);
  const path = join(dir, "f0.jpg");
  await writeFile(path, Buffer.from([0xff, 0xd8, 0xff, 0, 1, 2, 3, 4]));
  return {
    clipId: "c1",
    metadata: {
      durationSec: 2,
      width: 640,
      height: 360,
      fps: 30,
      codec: "h264",
      container: "mp4",
      rotationDeg: 0,
      hasVideoStream: true,
      sizeBytes: 100,
    },
    timestampsSec: [0.5],
    frameCount: 1,
    frames: [{ index: 0, timestampSec: 0.5, path, width: 320, height: 180 }],
    warnings: [],
    durationMs: 5,
    completedAt: new Date().toISOString(),
  };
}

describe("validateAnalysisReport", () => {
  it("accepts a valid response", () => {
    const report = validateAnalysisReport(sampleReport);
    assert.equal(report.scorecard.chelRating, sampleReport.scorecard.chelRating);
  });

  it("rejects malformed non-objects", () => {
    assert.throws(
      () => validateAnalysisReport("not-json-object"),
      (err: unknown) => err instanceof AiAnalysisError && err.internalCode === "AI_RESPONSE_INVALID",
    );
  });

  it("rejects schema-invalid responses", () => {
    assert.throws(
      () => validateAnalysisReport({ scorecard: {}, coachingMoments: [], filmRoom: {} }),
      (err: unknown) => err instanceof AiAnalysisError && err.publicCode === "ai_response_invalid",
    );
  });

  it("rejects out-of-range scores", () => {
    const bad = structuredClone(sampleReport);
    bad.scorecard.metrics[0]!.value = 150;
    assert.throws(() => validateAnalysisReport(bad), AiAnalysisError);
  });

  it("rejects missing required report fields", () => {
    const bad = structuredClone(sampleReport) as Record<string, unknown>;
    delete bad.filmRoom;
    assert.throws(() => validateAnalysisReport(bad), AiAnalysisError);
  });

  it("strips unsupported fabricated top-level fields", () => {
    const extra = { ...sampleReport, secretProviderDump: "nope", rank: 9001 };
    const report = validateAnalysisReport(extra);
    assert.equal("secretProviderDump" in report, false);
    assert.equal("rank" in report, false);
  });
});

describe("withAiRetries", () => {
  it("retries transient failures then succeeds", async () => {
    let n = 0;
    const result = await withAiRetries(async () => {
      n += 1;
      if (n < 2) throw new AiAnalysisError("AI_PROVIDER_UNAVAILABLE", "busy", { retryable: true });
      return "ok";
    }, { maxAttempts: 3, backoffMs: 1 });
    assert.equal(result, "ok");
    assert.equal(n, 2);
  });

  it("honors retry cap", async () => {
    let n = 0;
    await assert.rejects(
      () =>
        withAiRetries(
          async () => {
            n += 1;
            throw new AiAnalysisError("AI_RATE_LIMITED", "rl", { retryable: true });
          },
          { maxAttempts: 2, backoffMs: 1 },
        ),
      AiAnalysisError,
    );
    assert.equal(n, 2);
  });

  it("does not retry permanent auth failures", async () => {
    let n = 0;
    await assert.rejects(
      () =>
        withAiRetries(
          async () => {
            n += 1;
            throw new AiAnalysisError("AI_AUTHENTICATION_FAILED", "nope", { retryable: false });
          },
          { maxAttempts: 4, backoffMs: 1 },
        ),
      (err: unknown) =>
        err instanceof AiAnalysisError && err.internalCode === "AI_AUTHENTICATION_FAILED",
    );
    assert.equal(n, 1);
  });
});

describe("analyzeExtractedGameplay", () => {
  it("returns a validated report from a successful structured response", async () => {
    const fake = new FakeGameplayAnalysisProvider({ mode: "success" });
    setAnalysisProviderForTests(fake);
    const stages: string[] = [];
    const result = await analyzeExtractedGameplay(await extraction(), {
      signal: new AbortController().signal,
      onStage: (s) => stages.push(s),
    });
    assert.ok(result.report.scorecard);
    assert.equal(result.provenance.reportSource, "test");
    assert.equal(result.provenance.provider, "fake");
    assert.ok(stages.includes("analyzing_gameplay"));
    assert.ok(stages.includes("validating_report"));
    assert.equal(fake.callCount, 1);
  });

  it("surfaces immediate provider failure", async () => {
    setAnalysisProviderForTests(
      new FakeGameplayAnalysisProvider({
        mode: "fail",
        code: "AI_PROVIDER_UNAVAILABLE",
        retryable: false,
      }),
    );
    const ex = await extraction();
    await assert.rejects(
      () => analyzeExtractedGameplay(ex, { signal: new AbortController().signal }),
      (err: unknown) =>
        err instanceof AiAnalysisError && err.internalCode === "AI_PROVIDER_UNAVAILABLE",
    );
  });

  it("honors cancellation / timeout via abort signal", async () => {
    setAnalysisProviderForTests(new FakeGameplayAnalysisProvider({ mode: "delay", ms: 5_000 }));
    const controller = new AbortController();
    const p = analyzeExtractedGameplay(await extraction(), { signal: controller.signal });
    controller.abort();
    await assert.rejects(p, AiAnalysisError);
  });

  it("retries transient provider errors then succeeds", async () => {
    const fake = new FakeGameplayAnalysisProvider({
      mode: "fail-then-success",
      failTimes: 1,
      code: "AI_RATE_LIMITED",
    });
    setAnalysisProviderForTests(fake);
    // Temporarily lower attempts via env is hard; withAiRetries uses aiConfig.maxAttempts (2).
    const result = await analyzeExtractedGameplay(await extraction(), {
      signal: new AbortController().signal,
    });
    assert.ok(result.report);
    assert.equal(fake.callCount, 2);
  });

  it("rejects invalid provider payloads at validation", async () => {
    setAnalysisProviderForTests(
      new FakeGameplayAnalysisProvider({ mode: "invalid", payload: { nope: true } }),
    );
    const ex = await extraction();
    await assert.rejects(
      () => analyzeExtractedGameplay(ex, { signal: new AbortController().signal }),
      (err: unknown) =>
        err instanceof AiAnalysisError && err.internalCode === "AI_RESPONSE_INVALID",
    );
  });

  it("rate-limit errors are retryable AiAnalysisError", () => {
    const err = new AiAnalysisError("AI_RATE_LIMITED", "rl");
    assert.equal(err.retryable, true);
    assert.equal(err.publicCode, "ai_rate_limited");
  });
});
