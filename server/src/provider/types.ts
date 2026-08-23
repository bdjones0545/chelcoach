/**
 * Stable ScottyProvider interface — application services depend only on this.
 */
import type {
  ScottyAnalysisSubmission,
  ScottyCancelRequest,
  ScottyCancelResponse,
  ScottyJobLookup,
  ScottyJobStatusResponse,
  ScottyPlayerConfirmationSubmission,
  ScottyProviderHealth,
  ScottyProviderJobReceipt,
  ScottyReportLookup,
  ScottyReport,
} from "../scottyContract";

export interface ScottyProvider {
  readonly mode: "fake" | "simulator" | "direct_anthropic" | "scotty";

  /**
   * Whether this implementation can actually serve real production analysis traffic.
   *
   * Config validation can only answer "is this provider configured" — it cannot know that an
   * implementation is a skeleton that never reaches the network. Readiness therefore needs the
   * implementation itself to declare capability, so a fully-configured-but-incapable provider
   * fails closed instead of accepting submissions it can never fulfil.
   *
   * Declare this explicitly on each implementation. Never derive it from the mode string, the
   * class name, an environment variable, or a network probe: those are all restatements of
   * configuration, which is exactly the signal that failed to catch this.
   */
  readonly canServeProductionTraffic: boolean;

  submitAnalysis(input: ScottyAnalysisSubmission): Promise<ScottyProviderJobReceipt>;

  getJob(input: ScottyJobLookup): Promise<ScottyJobStatusResponse>;

  getReport(input: ScottyReportLookup): Promise<ScottyReport>;

  confirmPlayer?(input: ScottyPlayerConfirmationSubmission): Promise<ScottyJobStatusResponse>;

  cancelJob?(input: ScottyCancelRequest): Promise<ScottyCancelResponse>;

  health?(): Promise<ScottyProviderHealth>;
}
