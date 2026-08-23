/**
 * Analysis job repository — application system of record (Step 6).
 */
import { randomUUID } from "node:crypto";
import { SCOTTY_CONTRACT_VERSION, type ScottyJobStatus } from "../../scottyContract";
import type {
  AnalysisJob,
  AnalysisJobEvent,
  CancellationRequestedInput,
  CompleteWithReportInput,
  ConfirmationRequiredInput,
  CreateAnalysisJobInput,
  JobEventSource,
  MarkAcceptedInput,
  MarkCancelledInput,
  MarkFailedInput,
  PersistedAnalysisReport,
  ProviderStatusUpdateInput,
  ReconciliationQuery,
} from "./types";
import { isTerminalStatus } from "./transitions";

export class OptimisticConcurrencyError extends Error {
  constructor(message = "OPTIMISTIC_CONCURRENCY_CONFLICT") {
    super(message);
    this.name = "OptimisticConcurrencyError";
  }
}

export interface AnalysisJobRepository {
  createPendingSubmission(input: CreateAnalysisJobInput): Promise<AnalysisJob>;
  markAccepted(input: MarkAcceptedInput): Promise<AnalysisJob>;
  getByApplicationRequestId(applicationRequestId: string): Promise<AnalysisJob | null>;
  getOwnedJob(ownerId: string, applicationRequestId: string): Promise<AnalysisJob | null>;
  getByIdempotencyKey(idempotencyKey: string): Promise<AnalysisJob | null>;
  getByExternalJobId(provider: string, externalJobId: string): Promise<AnalysisJob | null>;
  updateFromProviderStatus(input: ProviderStatusUpdateInput): Promise<AnalysisJob>;
  markConfirmationRequired(input: ConfirmationRequiredInput): Promise<AnalysisJob>;
  markCancellationRequested(input: CancellationRequestedInput): Promise<AnalysisJob>;
  markFailed(input: MarkFailedInput): Promise<AnalysisJob>;
  markCancelled(input: MarkCancelledInput): Promise<AnalysisJob>;
  completeWithReport(input: CompleteWithReportInput): Promise<AnalysisJob>;
  markAcceptanceUnknown(applicationRequestId: string, expectedVersion: number): Promise<AnalysisJob>;
  markRemoteConfirmation(
    applicationRequestId: string,
    expectedVersion: number,
    selectedCandidateId: string,
    confirmedAt: string,
  ): Promise<AnalysisJob>;
  listReconciliationCandidates(input: ReconciliationQuery): Promise<AnalysisJob[]>;
  /** Owner-scoped listing for abuse quotas (bounded). */
  listByOwner(ownerId: string, limit?: number): Promise<AnalysisJob[]>;
  getReportByApplicationRequestId(
    applicationRequestId: string,
  ): Promise<PersistedAnalysisReport | null>;
  listEvents(applicationRequestId: string, limit?: number): Promise<AnalysisJobEvent[]>;
  recordCallbackEvent(input: {
    eventId: string;
    provider: AnalysisJob["provider"];
    externalJobId: string;
    applicationRequestId?: string;
    sequenceNumber: number;
    status?: ScottyJobStatus;
  }): Promise<{ inserted: boolean; processingStatus: string }>;
  clear?(): void;
}

function nowIso(): string {
  return new Date().toISOString();
}

function nextSync(pollAfterMs?: number | null): string | undefined {
  if (pollAfterMs === null) return undefined;
  const ms = pollAfterMs && pollAfterMs > 0 ? pollAfterMs : 2000;
  return new Date(Date.now() + ms).toISOString();
}

export class InMemoryAnalysisJobRepository implements AnalysisJobRepository {
  private jobs = new Map<string, AnalysisJob>();
  private byIdempotency = new Map<string, string>();
  private byExternal = new Map<string, string>();
  private events: AnalysisJobEvent[] = [];
  private reports = new Map<string, PersistedAnalysisReport>();
  private callbacks = new Map<string, true>();
  private locks = new Map<string, Promise<void>>();

  private async withJobLock<T>(applicationRequestId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(applicationRequestId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    this.locks.set(
      applicationRequestId,
      prev.then(() => gate),
    );
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  private appendEvent(
    job: AnalysisJob,
    input: {
      eventType: string;
      previousStatus?: ScottyJobStatus;
      eventSource: JobEventSource;
      sequenceNumber: number;
      providerSequenceNumber?: number;
      safeMessage?: string;
      safeErrorCode?: string;
      metadata?: Record<string, string | number | boolean | null>;
    },
  ): void {
    this.events.push({
      id: randomUUID(),
      applicationRequestId: job.applicationRequestId,
      uploadId: job.uploadId,
      ownerId: job.ownerId,
      jobId: job.id,
      eventType: input.eventType,
      canonicalStatus: job.canonicalStatus,
      previousStatus: input.previousStatus,
      sequenceNumber: input.sequenceNumber,
      providerSequenceNumber: input.providerSequenceNumber,
      eventSource: input.eventSource,
      safeMessage: input.safeMessage,
      safeErrorCode: input.safeErrorCode,
      metadata: input.metadata,
      occurredAt: nowIso(),
      receivedAt: nowIso(),
    });
  }

  private requireVersion(job: AnalysisJob, expected: number): void {
    if (job.version !== expected) throw new OptimisticConcurrencyError();
  }

  private save(job: AnalysisJob): AnalysisJob {
    const copy = structuredClone(job);
    this.jobs.set(copy.applicationRequestId, copy);
    this.byIdempotency.set(copy.idempotencyKey, copy.applicationRequestId);
    if (copy.externalJobId) {
      this.byExternal.set(`${copy.provider}:${copy.externalJobId}`, copy.applicationRequestId);
    }
    return structuredClone(copy);
  }

  async createPendingSubmission(input: CreateAnalysisJobInput): Promise<AnalysisJob> {
    const existing = this.byIdempotency.get(input.idempotencyKey);
    if (existing) {
      const cur = this.jobs.get(existing);
      if (cur) return structuredClone(cur);
    }
    const ts = nowIso();
    const job: AnalysisJob = {
      id: randomUUID(),
      applicationRequestId: input.applicationRequestId,
      uploadId: input.uploadId,
      ownerId: input.ownerId,
      provider: input.provider,
      contractVersion: input.contractVersion || SCOTTY_CONTRACT_VERSION,
      idempotencyKey: input.idempotencyKey,
      requestFingerprint: input.requestFingerprint,
      requestedCapabilities: input.requestedCapabilities,
      gameContext: input.gameContext,
      uploadContext: input.uploadContext,
      effectivePlayer: input.effectivePlayer,
      mediaClassification: input.mediaClassification,
      canonicalStatus: "queued",
      statusSequenceNumber: 1,
      submissionAcceptanceState: "pending",
      confirmationRequired: false,
      cancellationRequested: false,
      reconciliationRequired: false,
      retryable: false,
      reportAvailable: false,
      version: 1,
      submissionAttemptCount: 1,
      syncAttemptCount: 0,
      reportFetchAttemptCount: 0,
      cancellationAttemptCount: 0,
      confirmationAttemptCount: 0,
      reconciliationAttemptCount: 0,
      lastAttemptAt: ts,
      createdAt: ts,
      updatedAt: ts,
    };
    const saved = this.save(job);
    this.appendEvent(saved, {
      eventType: "job_created",
      eventSource: "application",
      sequenceNumber: 1,
      safeMessage: "Application job created",
    });
    return saved;
  }

  async markAccepted(input: MarkAcceptedInput): Promise<AnalysisJob> {
    return this.withJobLock(input.applicationRequestId, async () => {
      const job = this.jobs.get(input.applicationRequestId);
      if (!job) throw new Error("JOB_NOT_FOUND");
      this.requireVersion(job, input.expectedVersion);
      const prev = job.canonicalStatus;
      job.externalJobId = input.externalJobId;
      job.acceptedAt = input.acceptedAt;
      job.canonicalStatus = input.canonicalStatus;
      job.providerStatus = input.canonicalStatus;
      job.submissionAcceptanceState = "accepted";
      job.reconciliationRequired = false;
      job.nextSyncAfter = nextSync(input.pollAfterMs);
      job.version += 1;
      job.updatedAt = nowIso();
      job.lastSynchronizedAt = nowIso();
      const saved = this.save(job);
      this.appendEvent(saved, {
        eventType: "provider_accepted",
        previousStatus: prev,
        eventSource: "application",
        sequenceNumber: saved.statusSequenceNumber,
        safeMessage: "Provider acceptance persisted",
      });
      return saved;
    });
  }

  async markAcceptanceUnknown(
    applicationRequestId: string,
    expectedVersion: number,
  ): Promise<AnalysisJob> {
    return this.withJobLock(applicationRequestId, async () => {
      const job = this.jobs.get(applicationRequestId);
      if (!job) throw new Error("JOB_NOT_FOUND");
      this.requireVersion(job, expectedVersion);
      job.submissionAcceptanceState = "acceptance_unknown";
      job.reconciliationRequired = true;
      job.retryable = true;
      job.safeErrorCode = "ANALYSIS_TIMEOUT";
      job.safeErrorMessage = "Provider acceptance is uncertain; reconciliation required.";
      job.version += 1;
      job.updatedAt = nowIso();
      job.nextRetryAt = new Date(Date.now() + 5_000).toISOString();
      const saved = this.save(job);
      this.appendEvent(saved, {
        eventType: "acceptance_unknown",
        eventSource: "application",
        sequenceNumber: saved.statusSequenceNumber,
        safeErrorCode: "ANALYSIS_TIMEOUT",
        safeMessage: "Acceptance uncertain",
      });
      return saved;
    });
  }

  async getByApplicationRequestId(applicationRequestId: string): Promise<AnalysisJob | null> {
    const job = this.jobs.get(applicationRequestId);
    return job ? structuredClone(job) : null;
  }

  async getOwnedJob(ownerId: string, applicationRequestId: string): Promise<AnalysisJob | null> {
    const job = await this.getByApplicationRequestId(applicationRequestId);
    if (!job || job.ownerId !== ownerId) return null;
    return job;
  }

  async getByIdempotencyKey(idempotencyKey: string): Promise<AnalysisJob | null> {
    const id = this.byIdempotency.get(idempotencyKey);
    return id ? this.getByApplicationRequestId(id) : null;
  }

  async getByExternalJobId(provider: string, externalJobId: string): Promise<AnalysisJob | null> {
    const id = this.byExternal.get(`${provider}:${externalJobId}`);
    return id ? this.getByApplicationRequestId(id) : null;
  }

  async updateFromProviderStatus(input: ProviderStatusUpdateInput): Promise<AnalysisJob> {
    return this.withJobLock(input.applicationRequestId, async () => {
      const job = this.jobs.get(input.applicationRequestId);
      if (!job) throw new Error("JOB_NOT_FOUND");
      this.requireVersion(job, input.expectedVersion);
      const prev = job.canonicalStatus;
      if (isTerminalStatus(prev) && input.canonicalStatus !== prev) {
        throw new Error("TERMINAL_REGRESSION");
      }
      job.canonicalStatus = input.canonicalStatus;
      job.providerStatus = input.providerStatus;
      job.statusSequenceNumber = input.statusSequenceNumber;
      job.providerSequenceNumber = input.providerSequenceNumber;
      job.confirmationRequired = input.confirmationRequired;
      job.safeErrorCode = input.safeErrorCode;
      job.safeErrorMessage = input.safeErrorMessage;
      job.retryable = input.retryable ?? false;
      if (input.startedAt && !job.startedAt) job.startedAt = input.startedAt;
      if (input.canonicalStatus === "failed") job.failedAt = nowIso();
      job.lastSynchronizedAt = nowIso();
      job.nextSyncAfter =
        input.nextSyncAfter === null ? undefined : (input.nextSyncAfter ?? nextSync(2000));
      job.syncAttemptCount += 1;
      job.lastAttemptAt = nowIso();
      job.version += 1;
      job.updatedAt = nowIso();
      const saved = this.save(job);
      this.appendEvent(saved, {
        eventType: "status_advanced",
        previousStatus: prev,
        eventSource: input.eventSource,
        sequenceNumber: input.statusSequenceNumber,
        providerSequenceNumber: input.providerSequenceNumber,
        safeMessage: input.message,
        safeErrorCode: input.safeErrorCode,
      });
      return saved;
    });
  }

  async markConfirmationRequired(input: ConfirmationRequiredInput): Promise<AnalysisJob> {
    return this.updateFromProviderStatus({
      applicationRequestId: input.applicationRequestId,
      expectedVersion: input.expectedVersion,
      canonicalStatus: "awaiting_player_confirmation",
      providerStatus: "awaiting_player_confirmation",
      statusSequenceNumber: input.statusSequenceNumber,
      providerSequenceNumber: input.providerSequenceNumber,
      confirmationRequired: true,
      nextSyncAfter: null,
      message: input.message,
      eventSource: input.eventSource,
    });
  }

  async markCancellationRequested(input: CancellationRequestedInput): Promise<AnalysisJob> {
    return this.withJobLock(input.applicationRequestId, async () => {
      const job = this.jobs.get(input.applicationRequestId);
      if (!job) throw new Error("JOB_NOT_FOUND");
      this.requireVersion(job, input.expectedVersion);
      if (job.cancellationRequested) return structuredClone(job);
      job.cancellationRequested = true;
      job.cancellationRequestedAt = input.requestedAt;
      job.cancellationAttemptCount += 1;
      job.version += 1;
      job.updatedAt = nowIso();
      const saved = this.save(job);
      this.appendEvent(saved, {
        eventType: "cancellation_requested",
        eventSource: "user_cancellation",
        sequenceNumber: saved.statusSequenceNumber,
        safeMessage: "Cancellation requested",
      });
      return saved;
    });
  }

  async markFailed(input: MarkFailedInput): Promise<AnalysisJob> {
    return this.withJobLock(input.applicationRequestId, async () => {
      const job = this.jobs.get(input.applicationRequestId);
      if (!job) throw new Error("JOB_NOT_FOUND");
      this.requireVersion(job, input.expectedVersion);
      const prev = job.canonicalStatus;
      job.canonicalStatus = "failed";
      job.failedAt = nowIso();
      job.safeErrorCode = input.safeErrorCode;
      job.safeErrorMessage = input.safeErrorMessage;
      job.retryable = input.retryable;
      job.reconciliationRequired = input.reconciliationRequired ?? false;
      if (input.statusSequenceNumber) job.statusSequenceNumber = input.statusSequenceNumber;
      job.nextSyncAfter = undefined;
      job.version += 1;
      job.updatedAt = nowIso();
      const saved = this.save(job);
      this.appendEvent(saved, {
        eventType: "job_failed",
        previousStatus: prev,
        eventSource: input.eventSource,
        sequenceNumber: saved.statusSequenceNumber,
        safeErrorCode: input.safeErrorCode,
        safeMessage: input.safeErrorMessage,
      });
      return saved;
    });
  }

  async markCancelled(input: MarkCancelledInput): Promise<AnalysisJob> {
    return this.withJobLock(input.applicationRequestId, async () => {
      const job = this.jobs.get(input.applicationRequestId);
      if (!job) throw new Error("JOB_NOT_FOUND");
      this.requireVersion(job, input.expectedVersion);
      const prev = job.canonicalStatus;
      job.canonicalStatus = "cancelled";
      job.cancelledAt = input.cancelledAt;
      job.reportAvailable = false;
      job.confirmationRequired = false;
      job.reconciliationRequired = false;
      job.statusSequenceNumber = input.statusSequenceNumber;
      job.nextSyncAfter = undefined;
      job.version += 1;
      job.updatedAt = nowIso();
      const saved = this.save(job);
      this.appendEvent(saved, {
        eventType: "job_cancelled",
        previousStatus: prev,
        eventSource: input.eventSource,
        sequenceNumber: input.statusSequenceNumber,
        safeMessage: "Cancellation confirmed",
      });
      return saved;
    });
  }

  async completeWithReport(input: CompleteWithReportInput): Promise<AnalysisJob> {
    return this.withJobLock(input.applicationRequestId, async () => {
      const job = this.jobs.get(input.applicationRequestId);
      if (!job) throw new Error("JOB_NOT_FOUND");
      this.requireVersion(job, input.expectedVersion);
      if (this.reports.has(input.applicationRequestId)) {
        // Idempotent complete
        return structuredClone(job);
      }
      const prev = job.canonicalStatus;
      this.reports.set(input.applicationRequestId, structuredClone(input.report));
      job.reportId = input.report.id;
      job.reportAvailable = true;
      job.canonicalStatus = "completed";
      job.providerStatus = "completed";
      job.completedAt = input.completedAt;
      job.statusSequenceNumber = input.statusSequenceNumber;
      job.providerSequenceNumber = input.providerSequenceNumber;
      job.confirmationRequired = false;
      job.reconciliationRequired = false;
      job.nextSyncAfter = undefined;
      job.reportFetchAttemptCount += 1;
      job.version += 1;
      job.updatedAt = nowIso();
      job.lastSynchronizedAt = nowIso();
      const saved = this.save(job);
      this.appendEvent(saved, {
        eventType: "report_persisted",
        previousStatus: prev,
        eventSource: input.eventSource,
        sequenceNumber: input.statusSequenceNumber,
        providerSequenceNumber: input.providerSequenceNumber,
        safeMessage: "Validated report persisted; job completed",
      });
      return saved;
    });
  }

  async markRemoteConfirmation(
    applicationRequestId: string,
    expectedVersion: number,
    selectedCandidateId: string,
    confirmedAt: string,
  ): Promise<AnalysisJob> {
    return this.withJobLock(applicationRequestId, async () => {
      const job = this.jobs.get(applicationRequestId);
      if (!job) throw new Error("JOB_NOT_FOUND");
      this.requireVersion(job, expectedVersion);
      if (job.remoteConfirmationAt) return structuredClone(job);
      job.selectedRemoteCandidateId = selectedCandidateId;
      job.remoteConfirmationAt = confirmedAt;
      job.confirmationAttemptCount += 1;
      job.confirmationRequired = false;
      job.version += 1;
      job.updatedAt = nowIso();
      const saved = this.save(job);
      this.appendEvent(saved, {
        eventType: "remote_confirmation_persisted",
        eventSource: "user_confirmation",
        sequenceNumber: saved.statusSequenceNumber,
        safeMessage: "Provider-level player confirmation persisted",
      });
      return saved;
    });
  }

  async listReconciliationCandidates(input: ReconciliationQuery): Promise<AnalysisJob[]> {
    const now = input.now.getTime();
    return [...this.jobs.values()]
      .filter((j) => {
        if (j.reconciliationRequired) return true;
        // Terminal jobs are settled: a job terminalized by the acceptance timeout keeps its
        // acceptance_unknown marker, and without this guard it would be re-selected forever.
        if (
          j.submissionAcceptanceState === "acceptance_unknown" &&
          !isTerminalStatus(j.canonicalStatus)
        ) {
          return true;
        }
        if (j.cancellationRequested && j.canonicalStatus !== "cancelled") return true;
        if (isTerminalStatus(j.canonicalStatus)) return false;
        if (j.nextSyncAfter && new Date(j.nextSyncAfter).getTime() <= now) return true;
        if (j.nextRetryAt && new Date(j.nextRetryAt).getTime() <= now) return true;
        return false;
      })
      .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))
      .slice(0, input.limit)
      .map((j) => structuredClone(j));
  }

  async listByOwner(ownerId: string, limit = 100): Promise<AnalysisJob[]> {
    return [...this.jobs.values()]
      .filter((j) => j.ownerId === ownerId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit)
      .map((j) => structuredClone(j));
  }

  async getReportByApplicationRequestId(
    applicationRequestId: string,
  ): Promise<PersistedAnalysisReport | null> {
    const r = this.reports.get(applicationRequestId);
    return r ? structuredClone(r) : null;
  }

  async listEvents(applicationRequestId: string, limit = 50): Promise<AnalysisJobEvent[]> {
    return this.events
      .filter((e) => e.applicationRequestId === applicationRequestId)
      .slice(-limit)
      .map((e) => structuredClone(e));
  }

  async recordCallbackEvent(input: {
    eventId: string;
    provider: AnalysisJob["provider"];
    externalJobId: string;
    applicationRequestId?: string;
    sequenceNumber: number;
    status?: ScottyJobStatus;
  }): Promise<{ inserted: boolean; processingStatus: string }> {
    const key = `${input.provider}:${input.eventId}`;
    if (this.callbacks.has(key)) {
      return { inserted: false, processingStatus: "processed" };
    }
    this.callbacks.set(key, true);
    void input;
    return { inserted: true, processingStatus: "received" };
  }

  clear(): void {
    this.jobs.clear();
    this.byIdempotency.clear();
    this.byExternal.clear();
    this.events = [];
    this.reports.clear();
    this.callbacks.clear();
  }
}

let repo: AnalysisJobRepository = new InMemoryAnalysisJobRepository();

export function getAnalysisJobRepository(): AnalysisJobRepository {
  return repo;
}

export function setAnalysisJobRepositoryForTests(next: AnalysisJobRepository): void {
  repo = next;
}

export function resetAnalysisJobRepositoryForTests(): void {
  repo = new InMemoryAnalysisJobRepository();
}
