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
  readonly mode: "fake" | "direct_anthropic" | "scotty";

  submitAnalysis(input: ScottyAnalysisSubmission): Promise<ScottyProviderJobReceipt>;

  getJob(input: ScottyJobLookup): Promise<ScottyJobStatusResponse>;

  getReport(input: ScottyReportLookup): Promise<ScottyReport>;

  confirmPlayer?(input: ScottyPlayerConfirmationSubmission): Promise<ScottyJobStatusResponse>;

  cancelJob?(input: ScottyCancelRequest): Promise<ScottyCancelResponse>;

  health?(): Promise<ScottyProviderHealth>;
}
