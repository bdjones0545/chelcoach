/**
 * Durable state for the in-process Scotty worker (provider mode `scotty_worker`).
 *
 * One row per accepted submission. The worker claims runnable rows with a lease, advances them
 * through the contract's job statuses, and stores the validated report on the row. The
 * application job table (`scotty_analysis_jobs`) mirrors this through the ordinary provider
 * sync path — this table is the provider's side of the boundary, never read by routes directly.
 */
import type {
  ScottyAnalysisSubmission,
  ScottyErrorCode,
  ScottyJobStatus,
  ScottyReport,
} from "../../scottyContract";

export interface ScottyWorkerModelUsage {
  model: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
}

export interface ScottyWorkerJob {
  externalJobId: string;
  applicationRequestId: string;
  uploadId: string;
  ownerReference: string;
  idempotencyKey: string;
  requestFingerprint: string;
  contractVersion: string;
  submission: ScottyAnalysisSubmission;
  status: ScottyJobStatus;
  /** Monotonic; bumped on every status change so application sync never regresses. */
  sequenceNumber: number;
  attemptCount: number;
  maxAttempts: number;
  workerId?: string;
  claimExpiresAt?: string;
  nextAttemptAt?: string;
  acceptedAt: string;
  startedAt?: string;
  completedAt?: string;
  failedAt?: string;
  cancelledAt?: string;
  cancelReason?: string;
  errorCode?: ScottyErrorCode;
  errorMessage?: string;
  retryable: boolean;
  report?: ScottyReport;
  frameCount?: number;
  modelUsage?: ScottyWorkerModelUsage;
  /** Present once the job has been dispatched to a remote gateway (provider mode `scotty`). */
  remote?: ScottyRemoteDispatch;
  createdAt: string;
  updatedAt: string;
}

export interface ScottyRemoteDispatch {
  jobId: string;
  dispatchedAt: string;
  frameTimestampsSec: number[];
  remoteStatus?: string;
  lastPolledAt?: string;
  /** Set once ChelCoach's confirmed identity has been forwarded to the gateway. */
  autoConfirmedAt?: string;
}

export type ScottyWorkerJobPatch = Partial<
  Omit<ScottyWorkerJob, "externalJobId" | "idempotencyKey" | "applicationRequestId" | "createdAt">
>;

/**
 * Every non-terminal status is claimable: a local job in one of these states has a stale lease
 * and must be re-run, and a remote job must be polled whatever stage the gateway reports.
 */
export const RUNNABLE_STATUSES: ReadonlySet<ScottyJobStatus> = new Set([
  "queued",
  "inspecting_input",
  "extracting_frames",
  "identifying_controlled_player",
  "awaiting_player_confirmation",
  "validating_player_identity",
  "analyzing_gameplay",
  "validating_report",
  "finalizing",
]);

export const ACTIVE_STATUSES: ReadonlySet<ScottyJobStatus> = new Set([
  "queued",
  "inspecting_input",
  "extracting_frames",
  "identifying_controlled_player",
  "awaiting_player_confirmation",
  "validating_player_identity",
  "analyzing_gameplay",
  "validating_report",
  "finalizing",
]);
