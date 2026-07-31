/**
 * Narrow AI-analysis provider boundary.
 * Implementations return unknown structured data — callers must Zod-validate.
 */
import type { AiAnalysisInput } from "./input";

export interface AiProviderUsage {
  inputTokens?: number;
  outputTokens?: number;
}

export interface AiProviderResult {
  /** Untrusted structured payload (pre-validation). */
  raw: unknown;
  usage?: AiProviderUsage;
  model?: string;
  provider: string;
}

export interface GameplayAnalysisProvider {
  readonly name: string;
  analyzeGameplay(input: AiAnalysisInput, signal: AbortSignal): Promise<AiProviderResult>;
}

let injected: GameplayAnalysisProvider | undefined;

/** Test / smoke injection — bypasses Anthropic entirely. */
export function setAnalysisProviderForTests(provider: GameplayAnalysisProvider | undefined): void {
  injected = provider;
}

export function getInjectedAnalysisProvider(): GameplayAnalysisProvider | undefined {
  return injected;
}
