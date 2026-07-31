/**
 * Orchestrates AI gameplay analysis: build input → provider → validate.
 */
import { aiConfig, isAiConfigured, readProviderFromEnv } from "./config";
import { AiAnalysisError, toAiAnalysisError } from "./errors";
import { AnthropicGameplayAnalysisProvider } from "./anthropicProvider";
import { FakeGameplayAnalysisProvider } from "./fakeProvider";
import {
  buildAiAnalysisInput,
  releaseAiInputBuffers,
  type AiAnalysisInput,
  type BuildAiInputOptions,
} from "./input";
import {
  getInjectedAnalysisProvider,
  type AiProviderResult,
  type GameplayAnalysisProvider,
} from "./provider";
import { withAiRetries } from "./retry";
import { validateAnalysisReport } from "./validateReport";
import type { AnalysisReport } from "../contract";
import type { ExtractionResult } from "../media/types";
import { ANALYSIS_CONTRACT_VERSION, PROMPT_VERSION, RUBRIC_VERSION } from "./versions";

export type ReportSource = "demo" | "live_ai" | "test" | "deterministic_sample";

export interface AnalysisProvenance {
  reportSource: ReportSource;
  contractVersion: string;
  rubricVersion: string;
  promptVersion: string;
  provider: string;
  model: string;
  generatedAt: string;
  usage?: { inputTokens?: number; outputTokens?: number };
  extractionSummary?: {
    frameCount: number;
    durationSec: number;
    timestampsSec: number[];
  };
}

export interface AnalyzedGameplay {
  report: AnalysisReport;
  provenance: AnalysisProvenance;
}

export function resolveAnalysisProvider(): GameplayAnalysisProvider {
  const injected = getInjectedAnalysisProvider();
  if (injected) return injected;
  // Read env at call-time — ESM import hoisting can evaluate config before smoke sets AI_PROVIDER.
  if (readProviderFromEnv() === "fake") return new FakeGameplayAnalysisProvider();
  return new AnthropicGameplayAnalysisProvider();
}

export async function analyzeExtractedGameplay(
  extraction: ExtractionResult,
  options: {
    signal: AbortSignal;
    buildOptions?: BuildAiInputOptions;
    onStage?: (stage: "analyzing_gameplay" | "validating_report", progress: number) => void;
  },
): Promise<AnalyzedGameplay> {
  if (!isAiConfigured() && !getInjectedAnalysisProvider()) {
    throw new AiAnalysisError("AI_NOT_CONFIGURED", "AI not configured", { retryable: false });
  }

  let input: AiAnalysisInput | undefined;
  try {
    options.onStage?.("analyzing_gameplay", 60);
    input = await buildAiAnalysisInput(extraction, options.buildOptions);

    const provider = resolveAnalysisProvider();
    const providerResult: AiProviderResult = await withAiRetries(
      () => provider.analyzeGameplay(input!, options.signal),
      { signal: options.signal },
    );

    options.onStage?.("validating_report", 85);
    const report = validateAnalysisReport(providerResult.raw);

    const reportSource: ReportSource =
      provider.name === "fake" || provider.name === "test" ? "test" : "live_ai";

    return {
      report,
      provenance: {
        reportSource,
        contractVersion: ANALYSIS_CONTRACT_VERSION,
        rubricVersion: RUBRIC_VERSION,
        promptVersion: PROMPT_VERSION,
        provider: providerResult.provider,
        model: providerResult.model ?? aiConfig.model,
        generatedAt: new Date().toISOString(),
        ...(providerResult.usage ? { usage: providerResult.usage } : {}),
        extractionSummary: {
          frameCount: extraction.frameCount,
          durationSec: extraction.metadata.durationSec,
          timestampsSec: [...extraction.timestampsSec],
        },
      },
    };
  } catch (err) {
    throw toAiAnalysisError(err);
  } finally {
    if (input) releaseAiInputBuffers(input);
  }
}
