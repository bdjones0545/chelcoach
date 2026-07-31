/**
 * Deterministic fake provider for unit/smoke tests.
 * Never calls a paid API. Returns a schema-valid AnalysisReport shape.
 */
import { sampleReport } from "../data/sampleReport";
import type { AnalysisReport } from "../contract";
import { formatTimestamp, type AiAnalysisInput } from "./input";
import type { AiProviderResult, GameplayAnalysisProvider } from "./provider";

function reportFromInput(input: AiAnalysisInput): AnalysisReport {
  const base = structuredClone(sampleReport);
  const ts = input.timestampsSec[0] ?? 0;
  const stamp = formatTimestamp(ts);

  base.scorecard.eventsAnalyzed = Math.min(input.frames.length * 8, 120);
  base.scorecard.gameContext =
    "Coach-grade breakdown from sampled gameplay frames (deterministic test analyzer).";
  base.scorecard.biggestStrength = {
    title: "Visible structure in sampled frames",
    detail:
      "Based only on the supplied stills, positioning and support look organized in the visible sequences.",
  };
  base.scorecard.biggestWeakness = {
    title: "Limited frame evidence",
    detail:
      "Sparse sampled frames mean some decisions between timestamps are unavailable — treat scores as cautious.",
  };

  if (base.coachingMoments[0]) {
    base.coachingMoments[0].timestamp = stamp;
    base.coachingMoments[0].teaser =
      "Visible gameplay moment near a sampled timestamp — evidence limited to still frames.";
    base.coachingMoments[0].fullBreakdown =
      "This deterministic analyzer anchors coaching copy to a supplied sample timestamp without inventing controller inputs or hidden state.";
  }
  // Keep at most one moment for sparse fixtures.
  base.coachingMoments = base.coachingMoments.slice(0, 1);

  base.filmRoom.commentary =
    "Deterministic test analysis grounded in supplied frames and verified clip metadata only.";
  base.filmRoom.clipLabel = `Clip ${formatTimestamp(input.durationSec)}`;
  if (base.filmRoom.markers[0]) {
    base.filmRoom.markers[0].timestamp = stamp;
  }
  return base;
}

export class FakeGameplayAnalysisProvider implements GameplayAnalysisProvider {
  readonly name = "fake";
  private calls = 0;
  private readonly behavior: FakeBehavior;

  constructor(behavior: FakeBehavior = { mode: "success" }) {
    this.behavior = behavior;
  }

  get callCount(): number {
    return this.calls;
  }

  async analyzeGameplay(input: AiAnalysisInput, signal: AbortSignal): Promise<AiProviderResult> {
    this.calls += 1;
    if (signal.aborted) {
      const err = new Error("aborted");
      err.name = "AbortError";
      throw err;
    }

    const b = this.behavior;
    if (b.mode === "fail") {
      const { AiAnalysisError } = await import("./errors");
      throw new AiAnalysisError(b.code, b.detail, { retryable: b.retryable });
    }
    if (b.mode === "fail-then-success") {
      if (this.calls <= b.failTimes) {
        const { AiAnalysisError } = await import("./errors");
        throw new AiAnalysisError(b.code, "transient", { retryable: true });
      }
    }
    if (b.mode === "invalid") {
      return { raw: b.payload, provider: this.name, model: "fake-model", usage: { inputTokens: 1, outputTokens: 1 } };
    }
    if (b.mode === "delay") {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, b.ms);
        signal.addEventListener(
          "abort",
          () => {
            clearTimeout(t);
            const err = new Error("aborted");
            err.name = "AbortError";
            reject(err);
          },
          { once: true },
        );
      });
    }

    // Ensure no filesystem paths leak into the "provider" view of success payloads.
    const raw = reportFromInput(input);
    return {
      raw,
      provider: this.name,
      model: "fake-model",
      usage: { inputTokens: 100 + input.frames.length, outputTokens: 200 },
    };
  }
}

export type FakeBehavior =
  | { mode: "success" }
  | { mode: "fail"; code: import("./errors").AiInternalCode; detail?: string; retryable?: boolean }
  | { mode: "fail-then-success"; failTimes: number; code: import("./errors").AiInternalCode }
  | { mode: "invalid"; payload: unknown }
  | { mode: "delay"; ms: number };
