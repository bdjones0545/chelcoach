/**
 * Postgres-backed analysis job repository (Step 6).
 */
import { and, asc, desc, eq, inArray, isNull, lte, ne, or, sql } from "drizzle-orm";
import { createHash, randomUUID } from "node:crypto";
import { getDb } from "../../db/client";
import {
  scottyAnalysisJobEvents,
  scottyAnalysisJobs,
  scottyAnalysisReports,
  scottyCallbackEvents,
} from "../../db/schema";
import type { AnalysisProvider, ScottyJobStatus } from "../../scottyContract";
import {
  OptimisticConcurrencyError,
  type AnalysisJobRepository,
  type CallbackProcessingStatus,
} from "./jobRepository";
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

function toIso(d: Date | null | undefined): string | undefined {
  return d ? d.toISOString() : undefined;
}

function rowToJob(row: typeof scottyAnalysisJobs.$inferSelect): AnalysisJob {
  return {
    id: row.id,
    applicationRequestId: row.applicationRequestId,
    uploadId: row.uploadId,
    ownerId: row.ownerId,
    provider: row.provider as AnalysisProvider,
    externalJobId: row.externalJobId ?? undefined,
    contractVersion: row.contractVersion,
    idempotencyKey: row.idempotencyKey,
    requestFingerprint: row.requestFingerprint,
    requestedCapabilities: row.requestedCapabilities,
    gameContext: row.gameContext,
    uploadContext: row.uploadContext,
    effectivePlayer: row.effectivePlayer,
    mediaClassification: row.mediaClassification,
    canonicalStatus: row.canonicalStatus as ScottyJobStatus,
    providerStatus: (row.providerStatus as ScottyJobStatus | null) ?? undefined,
    statusSequenceNumber: row.statusSequenceNumber,
    providerSequenceNumber: row.providerSequenceNumber ?? undefined,
    submissionAcceptanceState: row.submissionAcceptanceState,
    confirmationRequired: row.confirmationRequired,
    cancellationRequested: row.cancellationRequested,
    cancellationRequestedAt: toIso(row.cancellationRequestedAt),
    acceptedAt: toIso(row.acceptedAt),
    startedAt: toIso(row.startedAt),
    completedAt: toIso(row.completedAt),
    failedAt: toIso(row.failedAt),
    cancelledAt: toIso(row.cancelledAt),
    lastSynchronizedAt: toIso(row.lastSynchronizedAt),
    nextSyncAfter: toIso(row.nextSyncAfter),
    reconciliationRequired: row.reconciliationRequired,
    safeErrorCode: (row.safeErrorCode as AnalysisJob["safeErrorCode"]) ?? undefined,
    safeErrorMessage: row.safeErrorMessage ?? undefined,
    retryable: row.retryable,
    reportId: row.reportId ?? undefined,
    reportAvailable: row.reportAvailable,
    version: row.version,
    submissionAttemptCount: row.submissionAttemptCount,
    syncAttemptCount: row.syncAttemptCount,
    reportFetchAttemptCount: row.reportFetchAttemptCount,
    cancellationAttemptCount: row.cancellationAttemptCount,
    confirmationAttemptCount: row.confirmationAttemptCount,
    reconciliationAttemptCount: row.reconciliationAttemptCount,
    lastAttemptAt: toIso(row.lastAttemptAt),
    nextRetryAt: toIso(row.nextRetryAt),
    selectedRemoteCandidateId: row.selectedRemoteCandidateId ?? undefined,
    remoteConfirmationAt: toIso(row.remoteConfirmationAt),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function reportRow(row: typeof scottyAnalysisReports.$inferSelect): PersistedAnalysisReport {
  return {
    id: row.id,
    applicationRequestId: row.applicationRequestId,
    jobId: row.jobId,
    externalJobId: row.externalJobId,
    uploadId: row.uploadId,
    ownerId: row.ownerId,
    provider: row.provider as AnalysisProvider,
    contractVersion: row.contractVersion,
    reportVersion: row.reportVersion,
    rubricVersion: row.rubricVersion,
    strategyKnowledgeVersion: row.strategyKnowledgeVersion,
    controlKnowledgeVersion: row.controlKnowledgeVersion,
    report: row.report,
    contentChecksum: row.contentChecksum,
    schemaValidatedAt: row.schemaValidatedAt.toISOString(),
    providerGeneratedAt: row.providerGeneratedAt.toISOString(),
    persistedAt: row.persistedAt.toISOString(),
  };
}

async function appendEvent(
  db: ReturnType<typeof getDb>,
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
): Promise<void> {
  await db.insert(scottyAnalysisJobEvents).values({
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
    occurredAt: new Date(),
  });
}

export class DrizzleAnalysisJobRepository implements AnalysisJobRepository {
  async createPendingSubmission(input: CreateAnalysisJobInput): Promise<AnalysisJob> {
    const db = getDb();
    const existing = await this.getByIdempotencyKey(input.idempotencyKey);
    if (existing) return existing;
    const id = randomUUID();
    const now = new Date();
    const [row] = await db
      .insert(scottyAnalysisJobs)
      .values({
        id,
        applicationRequestId: input.applicationRequestId,
        uploadId: input.uploadId,
        ownerId: input.ownerId,
        provider: input.provider,
        contractVersion: input.contractVersion,
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
        submissionAttemptCount: 1,
        lastAttemptAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    const job = rowToJob(row!);
    await appendEvent(db, job, {
      eventType: "job_created",
      eventSource: "application",
      sequenceNumber: 1,
      safeMessage: "Application job created",
    });
    return job;
  }

  async markAccepted(input: MarkAcceptedInput): Promise<AnalysisJob> {
    const db = getDb();
    return db.transaction(async (tx) => {
      const [cur] = await tx
        .select()
        .from(scottyAnalysisJobs)
        .where(eq(scottyAnalysisJobs.applicationRequestId, input.applicationRequestId))
        .for("update");
      if (!cur) throw new Error("JOB_NOT_FOUND");
      if (cur.version !== input.expectedVersion) throw new OptimisticConcurrencyError();
      const prev = cur.canonicalStatus as ScottyJobStatus;
      const [row] = await tx
        .update(scottyAnalysisJobs)
        .set({
          externalJobId: input.externalJobId,
          acceptedAt: new Date(input.acceptedAt),
          canonicalStatus: input.canonicalStatus,
          providerStatus: input.canonicalStatus,
          submissionAcceptanceState: "accepted",
          reconciliationRequired: false,
          nextSyncAfter: input.pollAfterMs
            ? new Date(Date.now() + input.pollAfterMs)
            : new Date(Date.now() + 2000),
          lastSynchronizedAt: new Date(),
          version: cur.version + 1,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(scottyAnalysisJobs.applicationRequestId, input.applicationRequestId),
            eq(scottyAnalysisJobs.version, input.expectedVersion),
          ),
        )
        .returning();
      if (!row) throw new OptimisticConcurrencyError();
      const job = rowToJob(row);
      await tx.insert(scottyAnalysisJobEvents).values({
        applicationRequestId: job.applicationRequestId,
        uploadId: job.uploadId,
        ownerId: job.ownerId,
        jobId: job.id,
        eventType: "provider_accepted",
        canonicalStatus: job.canonicalStatus,
        previousStatus: prev,
        sequenceNumber: job.statusSequenceNumber,
        eventSource: "application",
        safeMessage: "Provider acceptance persisted",
        occurredAt: new Date(),
      });
      return job;
    });
  }

  async markAcceptanceUnknown(
    applicationRequestId: string,
    expectedVersion: number,
  ): Promise<AnalysisJob> {
    const db = getDb();
    const [row] = await db
      .update(scottyAnalysisJobs)
      .set({
        submissionAcceptanceState: "acceptance_unknown",
        reconciliationRequired: true,
        retryable: true,
        safeErrorCode: "ANALYSIS_TIMEOUT",
        safeErrorMessage: "Provider acceptance is uncertain; reconciliation required.",
        nextRetryAt: new Date(Date.now() + 5_000),
        version: sql`${scottyAnalysisJobs.version} + 1`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(scottyAnalysisJobs.applicationRequestId, applicationRequestId),
          eq(scottyAnalysisJobs.version, expectedVersion),
        ),
      )
      .returning();
    if (!row) throw new OptimisticConcurrencyError();
    const job = rowToJob(row);
    await appendEvent(db, job, {
      eventType: "acceptance_unknown",
      eventSource: "application",
      sequenceNumber: job.statusSequenceNumber,
      safeErrorCode: "ANALYSIS_TIMEOUT",
      safeMessage: "Acceptance uncertain",
    });
    return job;
  }

  async getByApplicationRequestId(applicationRequestId: string): Promise<AnalysisJob | null> {
    const db = getDb();
    const [row] = await db
      .select()
      .from(scottyAnalysisJobs)
      .where(eq(scottyAnalysisJobs.applicationRequestId, applicationRequestId))
      .limit(1);
    return row ? rowToJob(row) : null;
  }

  async getOwnedJob(ownerId: string, applicationRequestId: string): Promise<AnalysisJob | null> {
    const db = getDb();
    const [row] = await db
      .select()
      .from(scottyAnalysisJobs)
      .where(
        and(
          eq(scottyAnalysisJobs.applicationRequestId, applicationRequestId),
          eq(scottyAnalysisJobs.ownerId, ownerId),
        ),
      )
      .limit(1);
    return row ? rowToJob(row) : null;
  }

  async getByIdempotencyKey(idempotencyKey: string): Promise<AnalysisJob | null> {
    const db = getDb();
    const [row] = await db
      .select()
      .from(scottyAnalysisJobs)
      .where(eq(scottyAnalysisJobs.idempotencyKey, idempotencyKey))
      .limit(1);
    return row ? rowToJob(row) : null;
  }

  async getByExternalJobId(provider: string, externalJobId: string): Promise<AnalysisJob | null> {
    const db = getDb();
    const [row] = await db
      .select()
      .from(scottyAnalysisJobs)
      .where(
        and(
          eq(scottyAnalysisJobs.provider, provider as AnalysisProvider),
          eq(scottyAnalysisJobs.externalJobId, externalJobId),
        ),
      )
      .limit(1);
    return row ? rowToJob(row) : null;
  }

  async updateFromProviderStatus(input: ProviderStatusUpdateInput): Promise<AnalysisJob> {
    const db = getDb();
    return db.transaction(async (tx) => {
      const [cur] = await tx
        .select()
        .from(scottyAnalysisJobs)
        .where(eq(scottyAnalysisJobs.applicationRequestId, input.applicationRequestId))
        .for("update");
      if (!cur) throw new Error("JOB_NOT_FOUND");
      if (cur.version !== input.expectedVersion) throw new OptimisticConcurrencyError();
      const prev = cur.canonicalStatus as ScottyJobStatus;
      const [row] = await tx
        .update(scottyAnalysisJobs)
        .set({
          canonicalStatus: input.canonicalStatus,
          providerStatus: input.providerStatus,
          statusSequenceNumber: input.statusSequenceNumber,
          providerSequenceNumber: input.providerSequenceNumber,
          confirmationRequired: input.confirmationRequired,
          safeErrorCode: input.safeErrorCode ?? null,
          safeErrorMessage: input.safeErrorMessage ?? null,
          retryable: input.retryable ?? false,
          startedAt: input.startedAt ? new Date(input.startedAt) : cur.startedAt,
          failedAt: input.canonicalStatus === "failed" ? new Date() : cur.failedAt,
          lastSynchronizedAt: new Date(),
          nextSyncAfter:
            input.nextSyncAfter === null
              ? null
              : input.nextSyncAfter
                ? new Date(input.nextSyncAfter)
                : new Date(Date.now() + 2000),
          syncAttemptCount: cur.syncAttemptCount + 1,
          lastAttemptAt: new Date(),
          version: cur.version + 1,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(scottyAnalysisJobs.applicationRequestId, input.applicationRequestId),
            eq(scottyAnalysisJobs.version, input.expectedVersion),
          ),
        )
        .returning();
      if (!row) throw new OptimisticConcurrencyError();
      const job = rowToJob(row);
      await tx.insert(scottyAnalysisJobEvents).values({
        applicationRequestId: job.applicationRequestId,
        uploadId: job.uploadId,
        ownerId: job.ownerId,
        jobId: job.id,
        eventType: "status_advanced",
        canonicalStatus: job.canonicalStatus,
        previousStatus: prev,
        sequenceNumber: input.statusSequenceNumber,
        providerSequenceNumber: input.providerSequenceNumber,
        eventSource: input.eventSource,
        safeMessage: input.message,
        safeErrorCode: input.safeErrorCode,
        occurredAt: new Date(),
      });
      return job;
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
    const db = getDb();
    const cur = await this.getByApplicationRequestId(input.applicationRequestId);
    if (!cur) throw new Error("JOB_NOT_FOUND");
    if (cur.cancellationRequested) return cur;
    const [row] = await db
      .update(scottyAnalysisJobs)
      .set({
        cancellationRequested: true,
        cancellationRequestedAt: new Date(input.requestedAt),
        cancellationAttemptCount: sql`${scottyAnalysisJobs.cancellationAttemptCount} + 1`,
        version: sql`${scottyAnalysisJobs.version} + 1`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(scottyAnalysisJobs.applicationRequestId, input.applicationRequestId),
          eq(scottyAnalysisJobs.version, input.expectedVersion),
        ),
      )
      .returning();
    if (!row) throw new OptimisticConcurrencyError();
    const job = rowToJob(row);
    await appendEvent(db, job, {
      eventType: "cancellation_requested",
      eventSource: "user_cancellation",
      sequenceNumber: job.statusSequenceNumber,
      safeMessage: "Cancellation requested",
    });
    return job;
  }

  async markFailed(input: MarkFailedInput): Promise<AnalysisJob> {
    const db = getDb();
    const cur = await this.getByApplicationRequestId(input.applicationRequestId);
    if (!cur) throw new Error("JOB_NOT_FOUND");
    const prev = cur.canonicalStatus;
    const [row] = await db
      .update(scottyAnalysisJobs)
      .set({
        canonicalStatus: "failed",
        failedAt: new Date(),
        safeErrorCode: input.safeErrorCode,
        safeErrorMessage: input.safeErrorMessage,
        retryable: input.retryable,
        reconciliationRequired: input.reconciliationRequired ?? false,
        statusSequenceNumber: input.statusSequenceNumber ?? cur.statusSequenceNumber,
        nextSyncAfter: null,
        version: sql`${scottyAnalysisJobs.version} + 1`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(scottyAnalysisJobs.applicationRequestId, input.applicationRequestId),
          eq(scottyAnalysisJobs.version, input.expectedVersion),
        ),
      )
      .returning();
    if (!row) throw new OptimisticConcurrencyError();
    const job = rowToJob(row);
    await appendEvent(db, job, {
      eventType: "job_failed",
      previousStatus: prev,
      eventSource: input.eventSource,
      sequenceNumber: job.statusSequenceNumber,
      safeErrorCode: input.safeErrorCode,
      safeMessage: input.safeErrorMessage,
    });
    return job;
  }

  async markCancelled(input: MarkCancelledInput): Promise<AnalysisJob> {
    const db = getDb();
    const cur = await this.getByApplicationRequestId(input.applicationRequestId);
    if (!cur) throw new Error("JOB_NOT_FOUND");
    const prev = cur.canonicalStatus;
    const [row] = await db
      .update(scottyAnalysisJobs)
      .set({
        canonicalStatus: "cancelled",
        cancelledAt: new Date(input.cancelledAt),
        reportAvailable: false,
        confirmationRequired: false,
        reconciliationRequired: false,
        statusSequenceNumber: input.statusSequenceNumber,
        nextSyncAfter: null,
        version: sql`${scottyAnalysisJobs.version} + 1`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(scottyAnalysisJobs.applicationRequestId, input.applicationRequestId),
          eq(scottyAnalysisJobs.version, input.expectedVersion),
        ),
      )
      .returning();
    if (!row) throw new OptimisticConcurrencyError();
    const job = rowToJob(row);
    await appendEvent(db, job, {
      eventType: "job_cancelled",
      previousStatus: prev,
      eventSource: input.eventSource,
      sequenceNumber: input.statusSequenceNumber,
      safeMessage: "Cancellation confirmed",
    });
    return job;
  }

  async completeWithReport(input: CompleteWithReportInput): Promise<AnalysisJob> {
    const db = getDb();
    return db.transaction(async (tx) => {
      const [cur] = await tx
        .select()
        .from(scottyAnalysisJobs)
        .where(eq(scottyAnalysisJobs.applicationRequestId, input.applicationRequestId))
        .for("update");
      if (!cur) throw new Error("JOB_NOT_FOUND");
      if (cur.version !== input.expectedVersion) throw new OptimisticConcurrencyError();
      if (cur.reportAvailable && cur.reportId) return rowToJob(cur);
      const prev = cur.canonicalStatus as ScottyJobStatus;
      await tx.insert(scottyAnalysisReports).values({
        id: input.report.id,
        applicationRequestId: input.report.applicationRequestId,
        jobId: cur.id,
        externalJobId: input.report.externalJobId,
        uploadId: input.report.uploadId,
        ownerId: input.report.ownerId,
        provider: input.report.provider,
        contractVersion: input.report.contractVersion,
        reportVersion: input.report.reportVersion,
        rubricVersion: input.report.rubricVersion,
        strategyKnowledgeVersion: input.report.strategyKnowledgeVersion,
        controlKnowledgeVersion: input.report.controlKnowledgeVersion,
        report: input.report.report,
        contentChecksum: input.report.contentChecksum,
        schemaValidatedAt: new Date(input.report.schemaValidatedAt),
        providerGeneratedAt: new Date(input.report.providerGeneratedAt),
        persistedAt: new Date(input.report.persistedAt),
      });
      const [row] = await tx
        .update(scottyAnalysisJobs)
        .set({
          reportId: input.report.id,
          reportAvailable: true,
          canonicalStatus: "completed",
          providerStatus: "completed",
          completedAt: new Date(input.completedAt),
          statusSequenceNumber: input.statusSequenceNumber,
          providerSequenceNumber: input.providerSequenceNumber,
          confirmationRequired: false,
          reconciliationRequired: false,
          nextSyncAfter: null,
          reportFetchAttemptCount: cur.reportFetchAttemptCount + 1,
          lastSynchronizedAt: new Date(),
          version: cur.version + 1,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(scottyAnalysisJobs.applicationRequestId, input.applicationRequestId),
            eq(scottyAnalysisJobs.version, input.expectedVersion),
          ),
        )
        .returning();
      if (!row) throw new OptimisticConcurrencyError();
      const job = rowToJob(row);
      await tx.insert(scottyAnalysisJobEvents).values({
        applicationRequestId: job.applicationRequestId,
        uploadId: job.uploadId,
        ownerId: job.ownerId,
        jobId: job.id,
        eventType: "report_persisted",
        canonicalStatus: "completed",
        previousStatus: prev,
        sequenceNumber: input.statusSequenceNumber,
        providerSequenceNumber: input.providerSequenceNumber,
        eventSource: input.eventSource,
        safeMessage: "Validated report persisted; job completed",
        occurredAt: new Date(),
      });
      return job;
    });
  }

  async markRemoteConfirmation(
    applicationRequestId: string,
    expectedVersion: number,
    selectedCandidateId: string,
    confirmedAt: string,
  ): Promise<AnalysisJob> {
    const cur = await this.getByApplicationRequestId(applicationRequestId);
    if (!cur) throw new Error("JOB_NOT_FOUND");
    if (cur.remoteConfirmationAt) return cur;
    const db = getDb();
    const [row] = await db
      .update(scottyAnalysisJobs)
      .set({
        selectedRemoteCandidateId: selectedCandidateId,
        remoteConfirmationAt: new Date(confirmedAt),
        confirmationAttemptCount: sql`${scottyAnalysisJobs.confirmationAttemptCount} + 1`,
        confirmationRequired: false,
        version: sql`${scottyAnalysisJobs.version} + 1`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(scottyAnalysisJobs.applicationRequestId, applicationRequestId),
          eq(scottyAnalysisJobs.version, expectedVersion),
        ),
      )
      .returning();
    if (!row) throw new OptimisticConcurrencyError();
    const job = rowToJob(row);
    await appendEvent(db, job, {
      eventType: "remote_confirmation_persisted",
      eventSource: "user_confirmation",
      sequenceNumber: job.statusSequenceNumber,
      safeMessage: "Provider-level player confirmation persisted",
    });
    return job;
  }

  async listReconciliationCandidates(input: ReconciliationQuery): Promise<AnalysisJob[]> {
    const db = getDb();
    const now = input.now;
    const activeStatuses = [
      "queued",
      "inspecting_input",
      "extracting_frames",
      "identifying_controlled_player",
      "awaiting_player_confirmation",
      "validating_player_identity",
      "analyzing_gameplay",
      "validating_report",
      "finalizing",
    ] as const;
    const rows = await db
      .select()
      .from(scottyAnalysisJobs)
      .where(
        or(
          eq(scottyAnalysisJobs.reconciliationRequired, true),
          // Terminal jobs are settled: a job terminalized by the acceptance timeout keeps its
          // acceptance_unknown marker, and without this guard it would be re-selected forever.
          and(
            eq(scottyAnalysisJobs.submissionAcceptanceState, "acceptance_unknown"),
            inArray(scottyAnalysisJobs.canonicalStatus, [...activeStatuses]),
          ),
          and(
            eq(scottyAnalysisJobs.cancellationRequested, true),
            ne(scottyAnalysisJobs.canonicalStatus, "cancelled"),
          ),
          and(
            inArray(scottyAnalysisJobs.canonicalStatus, [...activeStatuses]),
            or(
              lte(scottyAnalysisJobs.nextSyncAfter, now),
              lte(scottyAnalysisJobs.nextRetryAt, now),
              isNull(scottyAnalysisJobs.nextSyncAfter),
            ),
          ),
        ),
      )
      .orderBy(asc(scottyAnalysisJobs.updatedAt))
      .limit(input.limit);
    return rows.map(rowToJob);
  }

  async listByOwner(ownerId: string, limit = 100): Promise<AnalysisJob[]> {
    const db = getDb();
    const rows = await db
      .select()
      .from(scottyAnalysisJobs)
      .where(eq(scottyAnalysisJobs.ownerId, ownerId))
      .orderBy(desc(scottyAnalysisJobs.createdAt))
      .limit(limit);
    return rows.map(rowToJob);
  }

  async getReportByApplicationRequestId(
    applicationRequestId: string,
  ): Promise<PersistedAnalysisReport | null> {
    const db = getDb();
    const [row] = await db
      .select()
      .from(scottyAnalysisReports)
      .where(eq(scottyAnalysisReports.applicationRequestId, applicationRequestId))
      .limit(1);
    return row ? reportRow(row) : null;
  }

  async listEvents(applicationRequestId: string, limit = 50): Promise<AnalysisJobEvent[]> {
    const db = getDb();
    const rows = await db
      .select()
      .from(scottyAnalysisJobEvents)
      .where(eq(scottyAnalysisJobEvents.applicationRequestId, applicationRequestId))
      .orderBy(asc(scottyAnalysisJobEvents.receivedAt))
      .limit(limit);
    return rows.map((r) => ({
      id: r.id,
      applicationRequestId: r.applicationRequestId,
      uploadId: r.uploadId,
      ownerId: r.ownerId,
      jobId: r.jobId,
      eventType: r.eventType,
      canonicalStatus: r.canonicalStatus as ScottyJobStatus,
      previousStatus: (r.previousStatus as ScottyJobStatus | null) ?? undefined,
      sequenceNumber: r.sequenceNumber,
      providerSequenceNumber: r.providerSequenceNumber ?? undefined,
      eventSource: r.eventSource as JobEventSource,
      safeMessage: r.safeMessage ?? undefined,
      safeErrorCode: r.safeErrorCode ?? undefined,
      metadata: r.metadata ?? undefined,
      occurredAt: r.occurredAt.toISOString(),
      receivedAt: r.receivedAt.toISOString(),
    }));
  }

  async claimCallbackEvent(input: {
    eventId: string;
    provider: AnalysisJob["provider"];
    externalJobId: string;
    applicationRequestId?: string;
    sequenceNumber: number;
    status?: ScottyJobStatus;
  }): Promise<{ claimed: boolean; processingStatus: CallbackProcessingStatus }> {
    const db = getDb();
    const reclaimed = await db
      .update(scottyCallbackEvents)
      .set({ processingStatus: "received", safeErrorCode: null, processedAt: null })
      .where(
        and(
          eq(scottyCallbackEvents.provider, input.provider),
          eq(scottyCallbackEvents.eventId, input.eventId),
          eq(scottyCallbackEvents.processingStatus, "failed"),
        ),
      )
      .returning({ processingStatus: scottyCallbackEvents.processingStatus });
    if (reclaimed[0]) return { claimed: true, processingStatus: "received" };

    const inserted = await db
      .insert(scottyCallbackEvents)
      .values({
        eventId: input.eventId,
        provider: input.provider,
        externalJobId: input.externalJobId,
        applicationRequestId: input.applicationRequestId,
        sequenceNumber: input.sequenceNumber,
        status: input.status,
        processingStatus: "received",
      })
      .onConflictDoNothing({ target: [scottyCallbackEvents.provider, scottyCallbackEvents.eventId] })
      .returning({ processingStatus: scottyCallbackEvents.processingStatus });
    if (inserted[0]) return { claimed: true, processingStatus: "received" };
    const existing = await db
      .select({ processingStatus: scottyCallbackEvents.processingStatus })
      .from(scottyCallbackEvents)
      .where(
        and(
          eq(scottyCallbackEvents.provider, input.provider),
          eq(scottyCallbackEvents.eventId, input.eventId),
        ),
      )
      .limit(1);
    if (!existing[0]) throw new Error("CALLBACK_CLAIM_LOST");
    return { claimed: false, processingStatus: existing[0].processingStatus };
  }

  async completeCallbackEvent(
    provider: AnalysisJob["provider"],
    eventId: string,
    status: Exclude<CallbackProcessingStatus, "received" | "failed">,
  ): Promise<void> {
    await getDb()
      .update(scottyCallbackEvents)
      .set({ processingStatus: status, processedAt: new Date() })
      .where(
        and(
          eq(scottyCallbackEvents.provider, provider),
          eq(scottyCallbackEvents.eventId, eventId),
          eq(scottyCallbackEvents.processingStatus, "received"),
        ),
      );
  }

  async releaseCallbackEvent(provider: AnalysisJob["provider"], eventId: string): Promise<void> {
    await getDb()
      .update(scottyCallbackEvents)
      .set({ processingStatus: "failed", safeErrorCode: "PROCESSING_RETRYABLE" })
      .where(
        and(
          eq(scottyCallbackEvents.provider, provider),
          eq(scottyCallbackEvents.eventId, eventId),
          eq(scottyCallbackEvents.processingStatus, "received"),
        ),
      );
  }
}

export function checksumReport(report: unknown): string {
  return createHash("sha256").update(JSON.stringify(report)).digest("hex");
}
