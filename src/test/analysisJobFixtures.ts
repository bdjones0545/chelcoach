import type { ApplicationAnalysisStatus } from "../../shared/scotty/job";
import { toAnalysisJobView, type AnalysisJobView } from "../lib/analysisJobView";

export function makeStatus(
  overrides: Partial<ApplicationAnalysisStatus> = {},
): ApplicationAnalysisStatus {
  return {
    applicationRequestId: overrides.applicationRequestId ?? "req-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    uploadId: overrides.uploadId ?? "upload-1111-2222-3333-444444444444",
    status: overrides.status ?? "analyzing_gameplay",
    statusLabel: overrides.statusLabel ?? "Analyzing gameplay",
    sequenceNumber: overrides.sequenceNumber ?? 5,
    pollAfterMs: overrides.pollAfterMs === undefined ? 2000 : overrides.pollAfterMs,
    userActionRequired: overrides.userActionRequired ?? false,
    terminal: overrides.terminal ?? false,
    reportReady: overrides.reportReady ?? false,
    reportAvailable: overrides.reportAvailable ?? false,
    cancellationAvailable: overrides.cancellationAvailable ?? true,
    degraded: overrides.degraded ?? false,
    message: overrides.message,
    errorCode: overrides.errorCode,
    errorMessage: overrides.errorMessage,
    acceptedAt: overrides.acceptedAt ?? "2026-07-31T12:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-07-31T12:00:05.000Z",
    simulatorMode: overrides.simulatorMode,
    provider: overrides.provider,
  };
}

export function makeJob(overrides: Partial<ApplicationAnalysisStatus> = {}): AnalysisJobView {
  return toAnalysisJobView(makeStatus(overrides));
}
