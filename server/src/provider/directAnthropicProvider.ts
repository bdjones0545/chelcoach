/**
 * Development-only DirectAnthropicProvider.
 *
 * Isolates any future Anthropic client usage behind the ScottyProvider boundary.
 * Application routes and services must NOT import Anthropic SDKs.
 * Blocked in production via provider config validation.
 *
 * Step 4: no live Anthropic calls — throws PROVIDER_UNAVAILABLE unless a
 * test double injects behavior.
 */
import type {
  ScottyAnalysisSubmission,
  ScottyJobLookup,
  ScottyJobStatusResponse,
  ScottyProviderHealth,
  ScottyProviderJobReceipt,
  ScottyReport,
  ScottyReportLookup,
} from "../scottyContract";
import { scottyProviderHealthSchema } from "../scottyContract";
import { ProviderError } from "./errors";
import type { ScottyProvider } from "./types";

/** Marker — grep-friendly isolation of Anthropic concerns. */
export const DIRECT_ANTHROPIC_PROVIDER_MARKER = "DirectAnthropicProvider";

export class DirectAnthropicProvider implements ScottyProvider {
  readonly mode = "direct_anthropic" as const;
  // Development-only exploration path; unimplemented and blocked in production by config.
  readonly canServeProductionTraffic = false;

  async submitAnalysis(input: ScottyAnalysisSubmission): Promise<ScottyProviderJobReceipt> {
    void input;
    throw new ProviderError(
      "PROVIDER_UNAVAILABLE",
      "Direct Anthropic analysis is not implemented. Use CHELCOACH_ANALYSIS_PROVIDER=fake in development.",
      "configuration",
      { provider: "direct_anthropic", retryable: false, requestId: input.requestId },
    );
  }

  async getJob(input: ScottyJobLookup): Promise<ScottyJobStatusResponse> {
    void input;
    throw new ProviderError("PROVIDER_UNAVAILABLE", "Direct Anthropic getJob unavailable.", "configuration", {
      provider: "direct_anthropic",
      retryable: false,
    });
  }

  async getReport(input: ScottyReportLookup): Promise<ScottyReport> {
    void input;
    throw new ProviderError("PROVIDER_UNAVAILABLE", "Direct Anthropic getReport unavailable.", "configuration", {
      provider: "direct_anthropic",
      retryable: false,
    });
  }

  async health(): Promise<ScottyProviderHealth> {
    return scottyProviderHealthSchema.parse({
      provider: "direct_anthropic",
      configured: false,
      reachable: false,
      contractCompatible: true,
      status: "disabled",
      checkedAt: new Date().toISOString(),
      message: "Development-only stub — no Anthropic client loaded",
    });
  }
}
