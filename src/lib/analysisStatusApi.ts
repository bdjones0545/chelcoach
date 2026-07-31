/**
 * Compatibility re-exports for analysis status operations (Step 5 → Step 7).
 * Prefer `analysisClient.ts` for new code.
 */
export {
  getAnalysisStatus as fetchAnalysisStatus,
  getAnalysisReport as fetchAnalysisReport,
  cancelAnalysis as cancelAnalysisRequest,
  submitProviderPlayerConfirmation as confirmRemoteAnalysisPlayer,
} from "./analysisClient";

export type { AnalysisJobView as ApplicationAnalysisStatus } from "./analysisJobView";
