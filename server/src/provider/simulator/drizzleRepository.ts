/**
 * Durable Postgres simulator job repository — restart-safe Step 6.
 */
import { eq, isNull } from "drizzle-orm";
import { getDb } from "../../db/client";
import { scottySimulatorJobs } from "../../db/schema";
import type {
  MediaClassification,
  ScottyAnalysisSubmission,
  ScottyErrorCode,
  ScottyJobStatus,
  ScottyReport,
} from "../../scottyContract";
import type { SimulatorJobRepository } from "./repository";
import type { FailurePoint, SimulatorScenario } from "./scenarios";
import type { SimulatorJob } from "./types";

function rowToJob(row: typeof scottySimulatorJobs.$inferSelect): SimulatorJob {
  return {
    externalJobId: row.externalJobId,
    applicationRequestId: row.applicationRequestId,
    uploadId: row.uploadId,
    ownerReference: row.ownerReference,
    idempotencyKey: row.idempotencyKey,
    requestFingerprint: row.requestFingerprint,
    contractVersion: row.contractVersion,
    scenario: row.scenario as SimulatorScenario,
    acceptedAt: row.acceptedAt.toISOString(),
    submission: row.submission as ScottyAnalysisSubmission,
    effectivePlayer: row.effectivePlayer,
    capabilities: row.capabilities,
    mediaClassification: row.mediaClassification as MediaClassification,
    mediaDurationSec: row.mediaDurationSec,
    confirmationRequired: row.confirmationRequired,
    confirmationReceivedAt: row.confirmationReceivedAt?.toISOString(),
    selectedCandidateId: row.selectedCandidateId ?? undefined,
    cancelledAt: row.cancelledAt?.toISOString(),
    cancelReason: row.cancelReason ?? undefined,
    failurePoint: (row.failurePoint as FailurePoint) ?? null,
    terminalStatus: (row.terminalStatus as Extract<ScottyJobStatus, "completed" | "failed" | "cancelled"> | null) ?? undefined,
    errorCode: (row.errorCode as ScottyErrorCode | null) ?? undefined,
    errorMessage: row.errorMessage ?? undefined,
    report: (row.report as ScottyReport | null) ?? undefined,
    lastSequenceNumber: row.lastSequenceNumber,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export class DrizzleSimulatorJobRepository implements SimulatorJobRepository {
  async create(job: SimulatorJob): Promise<SimulatorJob> {
    const db = getDb();
    const existing = await this.getByIdempotencyKey(job.idempotencyKey);
    if (existing) return existing;
    const [row] = await db
      .insert(scottySimulatorJobs)
      .values({
        externalJobId: job.externalJobId,
        applicationRequestId: job.applicationRequestId,
        uploadId: job.uploadId,
        ownerReference: job.ownerReference,
        idempotencyKey: job.idempotencyKey,
        requestFingerprint: job.requestFingerprint,
        contractVersion: job.contractVersion,
        scenario: job.scenario,
        acceptedAt: new Date(job.acceptedAt),
        submission: job.submission,
        effectivePlayer: job.effectivePlayer,
        capabilities: job.capabilities,
        mediaClassification: job.mediaClassification,
        mediaDurationSec: job.mediaDurationSec,
        confirmationRequired: job.confirmationRequired,
        confirmationReceivedAt: job.confirmationReceivedAt
          ? new Date(job.confirmationReceivedAt)
          : null,
        selectedCandidateId: job.selectedCandidateId,
        cancelledAt: job.cancelledAt ? new Date(job.cancelledAt) : null,
        cancelReason: job.cancelReason,
        failurePoint: job.failurePoint,
        terminalStatus: job.terminalStatus,
        errorCode: job.errorCode,
        errorMessage: job.errorMessage,
        report: job.report,
        lastSequenceNumber: job.lastSequenceNumber,
        createdAt: new Date(job.createdAt),
        updatedAt: new Date(job.updatedAt),
      })
      .returning();
    return rowToJob(row!);
  }

  async getByExternalJobId(externalJobId: string): Promise<SimulatorJob | null> {
    const db = getDb();
    const [row] = await db
      .select()
      .from(scottySimulatorJobs)
      .where(eq(scottySimulatorJobs.externalJobId, externalJobId))
      .limit(1);
    return row ? rowToJob(row) : null;
  }

  async getByIdempotencyKey(idempotencyKey: string): Promise<SimulatorJob | null> {
    const db = getDb();
    const [row] = await db
      .select()
      .from(scottySimulatorJobs)
      .where(eq(scottySimulatorJobs.idempotencyKey, idempotencyKey))
      .limit(1);
    return row ? rowToJob(row) : null;
  }

  async update(job: SimulatorJob): Promise<SimulatorJob> {
    const db = getDb();
    const [row] = await db
      .update(scottySimulatorJobs)
      .set({
        confirmationReceivedAt: job.confirmationReceivedAt
          ? new Date(job.confirmationReceivedAt)
          : null,
        selectedCandidateId: job.selectedCandidateId,
        cancelledAt: job.cancelledAt ? new Date(job.cancelledAt) : null,
        cancelReason: job.cancelReason,
        failurePoint: job.failurePoint,
        terminalStatus: job.terminalStatus,
        errorCode: job.errorCode,
        errorMessage: job.errorMessage,
        report: job.report,
        lastSequenceNumber: job.lastSequenceNumber,
        updatedAt: new Date(job.updatedAt),
      })
      .where(eq(scottySimulatorJobs.externalJobId, job.externalJobId))
      .returning();
    if (!row) throw new Error("SIMULATOR_JOB_NOT_FOUND");
    return rowToJob(row);
  }

  async listActive(): Promise<SimulatorJob[]> {
    const db = getDb();
    const rows = await db
      .select()
      .from(scottySimulatorJobs)
      .where(isNull(scottySimulatorJobs.terminalStatus));
    return rows.map(rowToJob);
  }

  clear(): void {
    // No-op for drizzle — tests truncate via SQL helper.
  }
}
