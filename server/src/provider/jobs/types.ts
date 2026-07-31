/**
 * Application-owned durable analysis job model (Step 6).
 */
import type {
  AnalysisProvider,
  EffectivePlayerContext,
  GameContext,
  MediaClassification,
  RequestedCapabilities,
  ScottyErrorCode,
  ScottyJobStatus,
  ScottyReport,
  UploadGameplayContext,
} from "../../scottyContract";

export type SubmissionAcceptanceState =
  | "pending"
  | "accepted"
  | "acceptance_unknown"
  | "rejected";

export type JobEventSource =
  | "application"
  | "provider_poll"
  | "provider_callback"
  | "user_confirmation"
  | "user_cancellation"
  | "reconciliation"
  | "system";

export interface AnalysisJob {
  id: string;
  applicationRequestId: string;
  uploadId: string;
  ownerId: string;
  provider: AnalysisProvider;
  externalJobId?: string;
  contractVersion: string;
  idempotencyKey: string;
  requestFingerprint: string;
  requestedCapabilities: RequestedCapabilities;
  gameContext: GameContext;
  uploadContext: UploadGameplayContext;
  effectivePlayer: EffectivePlayerContext;
  mediaClassification: MediaClassification;
  canonicalStatus: ScottyJobStatus;
  providerStatus?: ScottyJobStatus;
  statusSequenceNumber: number;
  providerSequenceNumber?: number;
  submissionAcceptanceState: SubmissionAcceptanceState;
  confirmationRequired: boolean;
  cancellationRequested: boolean;
  cancellationRequestedAt?: string;
  acceptedAt?: string;
  startedAt?: string;
  completedAt?: string;
  failedAt?: string;
  cancelledAt?: string;
  lastSynchronizedAt?: string;
  nextSyncAfter?: string;
  reconciliationRequired: boolean;
  safeErrorCode?: ScottyErrorCode;
  safeErrorMessage?: string;
  retryable: boolean;
  reportId?: string;
  reportAvailable: boolean;
  version: number;
  submissionAttemptCount: number;
  syncAttemptCount: number;
  reportFetchAttemptCount: number;
  cancellationAttemptCount: number;
  confirmationAttemptCount: number;
  reconciliationAttemptCount: number;
  lastAttemptAt?: string;
  nextRetryAt?: string;
  selectedRemoteCandidateId?: string;
  remoteConfirmationAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface AnalysisJobEvent {
  id: string;
  applicationRequestId: string;
  uploadId: string;
  ownerId: string;
  jobId: string;
  eventType: string;
  canonicalStatus: ScottyJobStatus;
  previousStatus?: ScottyJobStatus;
  sequenceNumber: number;
  providerSequenceNumber?: number;
  eventSource: JobEventSource;
  safeMessage?: string;
  safeErrorCode?: string;
  metadata?: Record<string, string | number | boolean | null>;
  occurredAt: string;
  receivedAt: string;
}

export interface PersistedAnalysisReport {
  id: string;
  applicationRequestId: string;
  jobId: string;
  externalJobId: string;
  uploadId: string;
  ownerId: string;
  provider: AnalysisProvider;
  contractVersion: string;
  reportVersion: string;
  rubricVersion: string;
  strategyKnowledgeVersion: string;
  controlKnowledgeVersion: string;
  report: ScottyReport;
  contentChecksum: string;
  schemaValidatedAt: string;
  providerGeneratedAt: string;
  persistedAt: string;
}

export interface CreateAnalysisJobInput {
  applicationRequestId: string;
  uploadId: string;
  ownerId: string;
  provider: AnalysisProvider;
  contractVersion: string;
  idempotencyKey: string;
  requestFingerprint: string;
  requestedCapabilities: RequestedCapabilities;
  gameContext: GameContext;
  uploadContext: UploadGameplayContext;
  effectivePlayer: EffectivePlayerContext;
  mediaClassification: MediaClassification;
}

export interface MarkAcceptedInput {
  applicationRequestId: string;
  expectedVersion: number;
  externalJobId: string;
  acceptedAt: string;
  canonicalStatus: ScottyJobStatus;
  pollAfterMs?: number;
}

export interface ProviderStatusUpdateInput {
  applicationRequestId: string;
  expectedVersion: number;
  canonicalStatus: ScottyJobStatus;
  providerStatus: ScottyJobStatus;
  statusSequenceNumber: number;
  providerSequenceNumber: number;
  confirmationRequired: boolean;
  safeErrorCode?: ScottyErrorCode;
  safeErrorMessage?: string;
  retryable?: boolean;
  nextSyncAfter?: string | null;
  message?: string;
  eventSource: JobEventSource;
  startedAt?: string;
}

export interface CompleteWithReportInput {
  applicationRequestId: string;
  expectedVersion: number;
  report: PersistedAnalysisReport;
  completedAt: string;
  statusSequenceNumber: number;
  providerSequenceNumber: number;
  eventSource: JobEventSource;
}

export interface MarkFailedInput {
  applicationRequestId: string;
  expectedVersion: number;
  safeErrorCode: ScottyErrorCode;
  safeErrorMessage: string;
  retryable: boolean;
  reconciliationRequired?: boolean;
  statusSequenceNumber?: number;
  eventSource: JobEventSource;
}

export interface MarkCancelledInput {
  applicationRequestId: string;
  expectedVersion: number;
  cancelledAt: string;
  statusSequenceNumber: number;
  eventSource: JobEventSource;
}

export interface CancellationRequestedInput {
  applicationRequestId: string;
  expectedVersion: number;
  requestedAt: string;
}

export interface ConfirmationRequiredInput {
  applicationRequestId: string;
  expectedVersion: number;
  statusSequenceNumber: number;
  providerSequenceNumber: number;
  message?: string;
  eventSource: JobEventSource;
}

export interface ReconciliationQuery {
  now: Date;
  limit: number;
}

export type ProviderStatusDecision =
  | { decision: "advance"; nextSequence: number }
  | { decision: "idempotent" }
  | { decision: "stale" }
  | { decision: "conflict"; reason: string }
  | { decision: "reject"; reason: string }
  | { decision: "requires_report_fetch"; nextSequence: number };
