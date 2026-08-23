/**
 * Asynchronous local Scotty lifecycle simulator.
 * Accepts queued jobs; progression is elapsed-time derived (fake-clock friendly).
 */
import { createHash, randomUUID } from "node:crypto";
import {
  scottyAnalysisSubmissionSchema,
  scottyCancelResponseSchema,
  scottyJobStatusResponseSchema,
  scottyProviderHealthSchema,
  scottyProviderJobReceiptSchema,
  scottyReportSchema,
  type ScottyAnalysisSubmission,
  type ScottyCancelRequest,
  type ScottyCancelResponse,
  type ScottyJobLookup,
  type ScottyJobStatusResponse,
  type ScottyPlayerConfirmationSubmission,
  type ScottyProviderHealth,
  type ScottyProviderJobReceipt,
  type ScottyReport,
  type ScottyReportLookup,
} from "../../scottyContract";
import { ProviderError } from "../errors";
import { computeSubmissionFingerprint } from "../fakeProvider";
import type { ScottyProvider } from "../types";
import type { Clock } from "./clock";
import { SystemClock } from "./clock";
import { deriveSimulatorJobState } from "./lifecycle";
import { buildSimulatorReport } from "./reportBuilder";
import {
  getSimulatorJobRepository,
  type SimulatorJobRepository,
} from "./repository";
import {
  failurePointForScenario,
  requiresRemoteConfirmation,
  resolveSimulatorScenario,
  type SimulatorScenario,
} from "./scenarios";
import { loadSimulatorTimings, type SimulatorTimings } from "./timings";
import type { SimulatorJob } from "./types";

function logEvent(event: string, fields: Record<string, string | number | boolean | undefined>): void {
  const parts = Object.entries(fields)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${v}`);
  console.log(`[chelcoach-simulator] event=${event} ${parts.join(" ")}`);
}

export type SimulatorTimeoutInjection =
  | "none"
  | "submission"
  | "status"
  | "report";

export class SimulatorScottyProvider implements ScottyProvider {
  readonly mode = "simulator" as const;
  // Synthesises reports locally. Serving these as real coaching output would be fabrication.
  readonly canServeProductionTraffic = false;

  constructor(
    private opts: {
      clock?: Clock;
      timings?: SimulatorTimings;
      repo?: SimulatorJobRepository;
      defaultScenario?: SimulatorScenario | "auto";
      /** Injected scenario for tests. */
      forcedScenario?: SimulatorScenario;
      /** Deterministic timeout injection for tests — no real waits. */
      timeoutInjection?: SimulatorTimeoutInjection;
    } = {},
  ) {}

  /** Test helper to flip timeout injection without recreating the provider. */
  setTimeoutInjection(value: SimulatorTimeoutInjection): void {
    this.opts.timeoutInjection = value;
  }

  private clock(): Clock {
    return this.opts.clock ?? new SystemClock();
  }

  private timings(): SimulatorTimings {
    return this.opts.timings ?? loadSimulatorTimings();
  }

  private repo(): SimulatorJobRepository {
    return this.opts.repo ?? getSimulatorJobRepository();
  }

  async submitAnalysis(input: ScottyAnalysisSubmission): Promise<ScottyProviderJobReceipt> {
    const parsed = scottyAnalysisSubmissionSchema.parse(input);
    if (this.opts.timeoutInjection === "submission") {
      throw new ProviderError(
        "ANALYSIS_TIMEOUT",
        "Simulator submission timed out before acceptance.",
        "timeout",
        { provider: "simulator", retryable: true, requestId: parsed.requestId },
      );
    }
    const scenario = resolveSimulatorScenario({
      injected: this.opts.forcedScenario,
      envDefault: this.opts.defaultScenario,
      mediaClassification: parsed.mediaClassification,
    });

    const fingerprint = computeSubmissionFingerprint(parsed);
    const existing = await this.repo().getByIdempotencyKey(parsed.idempotencyKey);
    if (existing) {
      if (existing.requestFingerprint !== fingerprint) {
        throw new ProviderError(
          "IDEMPOTENCY_CONFLICT",
          "Idempotency key reused with different request fingerprint.",
          "validation",
          { provider: "simulator", retryable: false, requestId: parsed.requestId },
        );
      }
      logEvent("simulator_duplicate_reused", {
        applicationRequestId: existing.applicationRequestId,
        externalJobId: existing.externalJobId,
        uploadId: existing.uploadId,
        scenario: existing.scenario,
      });
      return scottyProviderJobReceiptSchema.parse({
        contractVersion: existing.contractVersion,
        provider: "simulator",
        externalJobId: existing.externalJobId,
        applicationRequestId: existing.applicationRequestId,
        idempotencyKey: existing.idempotencyKey,
        acceptedAt: existing.acceptedAt,
        status: "queued",
        pollAfterMs: this.timings().pollActiveMs,
      });
    }

    const now = this.clock().now();
    const externalJobId = `sim_${createHash("sha256").update(parsed.idempotencyKey).digest("hex").slice(0, 16)}`;
    const job: SimulatorJob = {
      externalJobId,
      applicationRequestId: parsed.requestId,
      uploadId: parsed.uploadId,
      ownerReference: parsed.ownerReference,
      idempotencyKey: parsed.idempotencyKey,
      requestFingerprint: fingerprint,
      contractVersion: parsed.contractVersion,
      scenario,
      acceptedAt: now.toISOString(),
      submission: parsed,
      effectivePlayer: parsed.effectivePlayer,
      capabilities: parsed.capabilities,
      mediaClassification: parsed.mediaClassification,
      mediaDurationSec: parsed.mediaMetadata.durationSec,
      confirmationRequired: requiresRemoteConfirmation(scenario),
      failurePoint: failurePointForScenario(scenario),
      lastSequenceNumber: 1,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };

    await this.repo().create(job);
    logEvent("simulator_job_created", {
      applicationRequestId: job.applicationRequestId,
      externalJobId: job.externalJobId,
      uploadId: job.uploadId,
      scenario: job.scenario,
      status: "queued",
      sequenceNumber: 1,
    });

    return scottyProviderJobReceiptSchema.parse({
      contractVersion: parsed.contractVersion,
      provider: "simulator",
      externalJobId,
      applicationRequestId: parsed.requestId,
      idempotencyKey: parsed.idempotencyKey,
      acceptedAt: job.acceptedAt,
      status: "queued",
      pollAfterMs: this.timings().pollActiveMs,
    });
  }

  private async materialize(job: SimulatorJob): Promise<{
    job: SimulatorJob;
    derived: ReturnType<typeof deriveSimulatorJobState>;
  }> {
    const now = this.clock().now();
    const derived = deriveSimulatorJobState(job, now, this.timings());

    // Reject status regression.
    if (derived.sequenceNumber < job.lastSequenceNumber && !derived.terminal) {
      derived.sequenceNumber = job.lastSequenceNumber;
    }

    let next = { ...job, lastSequenceNumber: derived.sequenceNumber, updatedAt: now.toISOString() };

    if (derived.status !== "queued" && derived.sequenceNumber !== job.lastSequenceNumber) {
      logEvent("simulator_lifecycle_transition", {
        applicationRequestId: job.applicationRequestId,
        externalJobId: job.externalJobId,
        status: derived.status,
        sequenceNumber: derived.sequenceNumber,
        scenario: job.scenario,
      });
    }

    if (derived.status === "awaiting_player_confirmation") {
      logEvent("simulator_awaiting_confirmation", {
        applicationRequestId: job.applicationRequestId,
        externalJobId: job.externalJobId,
        sequenceNumber: derived.sequenceNumber,
      });
    }

    if (derived.terminal && derived.status === "failed") {
      next = {
        ...next,
        terminalStatus: "failed",
        errorCode: derived.errorCode,
        errorMessage: derived.errorMessage,
      };
      logEvent("simulator_job_failed", {
        applicationRequestId: job.applicationRequestId,
        externalJobId: job.externalJobId,
        errorCode: derived.errorCode,
        scenario: job.scenario,
      });
    }

    if (derived.terminal && derived.status === "completed" && !job.report) {
      try {
        const report = buildSimulatorReport({ job: next, now });
        next = { ...next, report, terminalStatus: "completed" };
        logEvent("simulator_report_built", {
          applicationRequestId: job.applicationRequestId,
          externalJobId: job.externalJobId,
          scenario: job.scenario,
        });
      } catch (err) {
        next = {
          ...next,
          terminalStatus: "failed",
          errorCode: "REPORT_VALIDATION_FAILED",
          errorMessage: err instanceof Error ? err.message : "Report validation failed",
        };
        derived.status = "failed";
        derived.terminal = true;
        derived.reportReady = false;
        derived.errorCode = "REPORT_VALIDATION_FAILED";
        derived.errorMessage = next.errorMessage;
        derived.pollAfterMs = null;
        logEvent("simulator_job_failed", {
          applicationRequestId: job.applicationRequestId,
          externalJobId: job.externalJobId,
          errorCode: "REPORT_VALIDATION_FAILED",
        });
      }
    }

    await this.repo().update(next);
    return { job: next, derived };
  }

  async getJob(input: ScottyJobLookup): Promise<ScottyJobStatusResponse> {
    if (this.opts.timeoutInjection === "status") {
      throw new ProviderError(
        "ANALYSIS_TIMEOUT",
        "Simulator status lookup timed out.",
        "timeout",
        { provider: "simulator", retryable: true },
      );
    }
    const job = await this.repo().getByExternalJobId(input.externalJobId);
    if (!job) {
      throw new ProviderError("ANALYSIS_FAILED", "Unknown simulator job.", "validation", {
        provider: "simulator",
        retryable: false,
      });
    }
    if (input.applicationRequestId && input.applicationRequestId !== job.applicationRequestId) {
      throw new ProviderError("FORBIDDEN", "Request mismatch.", "authorization", {
        provider: "simulator",
        retryable: false,
      });
    }

    const { job: latest, derived } = await this.materialize(job);
    return scottyJobStatusResponseSchema.parse({
      contractVersion: latest.contractVersion,
      jobId: latest.externalJobId,
      uploadId: latest.uploadId,
      provider: "simulator",
      externalScottyJobId: latest.externalJobId,
      applicationRequestId: latest.applicationRequestId,
      status: derived.status,
      sequenceNumber: derived.sequenceNumber,
      pollAfterMs: derived.pollAfterMs,
      userActionRequired: derived.userActionRequired,
      terminal: derived.terminal,
      message: derived.message,
      errorCode: derived.errorCode,
      errorMessage: derived.errorMessage,
      reportReady: derived.reportReady,
      enteredAt: derived.enteredAt,
      updatedAt: latest.updatedAt,
      playerContext: latest.submission.playerContext,
      gameContext: latest.submission.gameContext,
    });
  }

  async getReport(input: ScottyReportLookup): Promise<ScottyReport> {
    if (this.opts.timeoutInjection === "report") {
      throw new ProviderError(
        "ANALYSIS_TIMEOUT",
        "Simulator report retrieval timed out.",
        "timeout",
        { provider: "simulator", retryable: true },
      );
    }
    const job = await this.repo().getByExternalJobId(input.externalJobId);
    if (!job) {
      throw new ProviderError("ANALYSIS_FAILED", "Unknown simulator job.", "validation", {
        provider: "simulator",
        retryable: false,
      });
    }
    const { job: latest, derived } = await this.materialize(job);

    if (derived.status === "awaiting_player_confirmation") {
      throw new ProviderError(
        "PLAYER_IDENTITY_UNCONFIRMED",
        "Confirm which player you controlled before continuing.",
        "validation",
        { provider: "simulator", retryable: false },
      );
    }
    if (derived.status === "cancelled") {
      throw new ProviderError("JOB_CANCELLED", "This analysis job was cancelled.", "permanent_failure", {
        provider: "simulator",
        retryable: false,
      });
    }
    if (derived.status === "failed") {
      throw new ProviderError(
        derived.errorCode ?? "ANALYSIS_FAILED",
        derived.errorMessage ?? "Analysis failed.",
        "permanent_failure",
        { provider: "simulator", retryable: false },
      );
    }
    if (!derived.reportReady || !latest.report) {
      throw new ProviderError("REPORT_NOT_READY", "The coaching report is not ready yet.", "validation", {
        provider: "simulator",
        retryable: true,
      });
    }
    return scottyReportSchema.parse(latest.report);
  }

  async confirmPlayer(input: ScottyPlayerConfirmationSubmission): Promise<ScottyJobStatusResponse> {
    const job = await this.repo().getByExternalJobId(input.externalJobId);
    if (!job) {
      throw new ProviderError("ANALYSIS_FAILED", "Unknown simulator job.", "validation", {
        provider: "simulator",
        retryable: false,
      });
    }
    if (input.applicationRequestId !== job.applicationRequestId) {
      throw new ProviderError("FORBIDDEN", "Confirmation for wrong job.", "authorization", {
        provider: "simulator",
        retryable: false,
      });
    }

    const { derived } = await this.materialize(job);
    if (job.confirmationReceivedAt) {
      // Idempotent
      return this.getJob({
        externalJobId: job.externalJobId,
        applicationRequestId: job.applicationRequestId,
      });
    }
    if (derived.status !== "awaiting_player_confirmation") {
      throw new ProviderError(
        "PLAYER_CONFIRMATION_INVALID",
        "Job is not awaiting player confirmation.",
        "validation",
        { provider: "simulator", retryable: false },
      );
    }

    const now = this.clock().now();
    const updated: SimulatorJob = {
      ...job,
      confirmationReceivedAt: now.toISOString(),
      selectedCandidateId: input.selectedCandidateId,
      updatedAt: now.toISOString(),
    };
    await this.repo().update(updated);
    logEvent("simulator_confirmation_received", {
      applicationRequestId: job.applicationRequestId,
      externalJobId: job.externalJobId,
      sequenceNumber: derived.sequenceNumber,
    });
    return this.getJob({
      externalJobId: job.externalJobId,
      applicationRequestId: job.applicationRequestId,
    });
  }

  async cancelJob(input: ScottyCancelRequest): Promise<ScottyCancelResponse> {
    const job = await this.repo().getByExternalJobId(input.externalJobId);
    if (!job) {
      throw new ProviderError("ANALYSIS_FAILED", "Unknown simulator job.", "validation", {
        provider: "simulator",
        retryable: false,
      });
    }
    if (input.applicationRequestId !== job.applicationRequestId) {
      throw new ProviderError("FORBIDDEN", "Cancel for wrong job.", "authorization", {
        provider: "simulator",
        retryable: false,
      });
    }

    const { job: latest, derived } = await this.materialize(job);
    if (derived.status === "completed") {
      throw new ProviderError(
        "INVALID_REQUEST",
        "Completed jobs cannot be cancelled.",
        "validation",
        { provider: "simulator", retryable: false },
      );
    }
    if (latest.cancelledAt || derived.status === "cancelled") {
      return scottyCancelResponseSchema.parse({
        externalJobId: latest.externalJobId,
        status: "cancelled",
        cancelledAt: latest.cancelledAt ?? latest.updatedAt,
      });
    }

    const now = this.clock().now();
    const updated: SimulatorJob = {
      ...latest,
      cancelledAt: now.toISOString(),
      cancelReason: input.reason ?? "Cancelled by user",
      terminalStatus: "cancelled",
      report: undefined,
      updatedAt: now.toISOString(),
    };
    await this.repo().update(updated);
    logEvent("simulator_job_cancelled", {
      applicationRequestId: latest.applicationRequestId,
      externalJobId: latest.externalJobId,
      scenario: latest.scenario,
    });
    return scottyCancelResponseSchema.parse({
      externalJobId: updated.externalJobId,
      status: "cancelled",
      cancelledAt: updated.cancelledAt!,
    });
  }

  async health(): Promise<ScottyProviderHealth> {
    const active = await this.repo().listActive();
    const status = active.length > 20 ? "degraded" : "healthy";
    logEvent("simulator_health_checked", { status, activeJobs: active.length });
    return scottyProviderHealthSchema.parse({
      provider: "simulator",
      configured: true,
      reachable: true,
      contractCompatible: true,
      status,
      checkedAt: this.clock().now().toISOString(),
      message: `Simulator enabled (${active.length} active jobs)`,
    });
  }
}

/** Test helper — unique candidate id for remote confirmation. */
export function simulatorCandidateId(): string {
  return `sim_cand_${randomUUID().slice(0, 8)}`;
}
