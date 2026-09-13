/**
 * ScottyRemoteProvider — provider mode `scotty`: analysis runs on Scottie (orgo-desktop).
 *
 * Same durable-job shape as the in-process worker: submission creates a queued row,
 * `getJob`/`getReport` read the row, and the scheduler tick (`processRemoteScottyJob`) does the
 * network work — sampling frames, dispatching them to the gateway, polling, and mapping the
 * finished report onto the contract. The poll path never talks to the VM.
 */
import { createHash } from "node:crypto";
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
import { getScottyWorkerJobRepository, type ScottyWorkerJobRepository } from "../scottyWorker/repository";
import { isTerminalWorkerStatus, workerJobToStatus } from "../scottyWorker/provider";
import type { ScottyWorkerJob } from "../scottyWorker/types";
import type { ScottyProvider } from "../types";
import { ScottieClient, type ScottieClientConfig } from "./client";

export const SCOTTY_REMOTE_POLL_MS = 4000;
/** Poll ticks re-claim the row; dispatch failures are the only thing that should exhaust this. */
const REMOTE_MAX_ATTEMPTS = 400;

export interface ScottyRemoteConfig extends ScottieClientConfig {
  configured: boolean;
}

export function loadScottyRemoteConfig(env: NodeJS.ProcessEnv = process.env): ScottyRemoteConfig {
  const baseUrl = (env.SCOTTY_BASE_URL ?? "").trim();
  const apiKey = (env.SCOTTY_API_KEY ?? "").trim();
  const signingSecret = (env.SCOTTY_SIGNING_SECRET ?? "").trim();
  const enabled = ["1", "true"].includes((env.CHELCOACH_SCOTTIE_ENABLED ?? "").trim().toLowerCase());
  return {
    baseUrl,
    apiKey,
    signingSecret,
    statusTimeoutMs: Number(env.SCOTTY_STATUS_TIMEOUT_MS) || 10_000,
    requestTimeoutMs: Number(env.SCOTTY_REQUEST_TIMEOUT_MS) || 60_000,
    configured: enabled && /^https:\/\//.test(baseUrl) && apiKey.length >= 24 && signingSecret.length >= 24,
  };
}

function logEvent(event: string, fields: Record<string, string | number | boolean | undefined>): void {
  const parts = Object.entries(fields)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${v}`);
  console.log(`[chelcoach-scotty-remote] event=${event} ${parts.join(" ")}`);
}

export class ScottyRemoteProvider implements ScottyProvider {
  readonly mode = "scotty" as const;
  readonly canServeProductionTraffic: boolean;
  private readonly cfg: ScottyRemoteConfig;

  constructor(private opts: { repo?: ScottyWorkerJobRepository; config?: ScottyRemoteConfig; client?: ScottieClient } = {}) {
    this.cfg = opts.config ?? loadScottyRemoteConfig();
    // Capability = a real, authenticated transport is configured. The gateway's own readiness
    // (its provider, its model) is checked by health(), and every job carries its own outcome.
    this.canServeProductionTraffic = this.cfg.configured;
  }

  client(): ScottieClient {
    return this.opts.client ?? new ScottieClient(this.cfg);
  }

  private repo(): ScottyWorkerJobRepository {
    return this.opts.repo ?? getScottyWorkerJobRepository();
  }

  async submitAnalysis(input: ScottyAnalysisSubmission): Promise<ScottyProviderJobReceipt> {
    const parsed = scottyAnalysisSubmissionSchema.parse(input);
    const fingerprint = computeSubmissionFingerprint(parsed);
    const existing = await this.repo().getByIdempotencyKey(parsed.idempotencyKey);
    if (existing) {
      if (existing.requestFingerprint !== fingerprint) {
        throw new ProviderError("IDEMPOTENCY_CONFLICT", "Idempotency key reused with different request fingerprint.", "validation", {
          provider: "scotty",
          retryable: false,
          requestId: parsed.requestId,
        });
      }
      return scottyProviderJobReceiptSchema.parse({
        contractVersion: existing.contractVersion,
        provider: "scotty",
        externalJobId: existing.externalJobId,
        applicationRequestId: existing.applicationRequestId,
        idempotencyKey: existing.idempotencyKey,
        acceptedAt: existing.acceptedAt,
        status: existing.status,
        pollAfterMs: SCOTTY_REMOTE_POLL_MS,
      });
    }
    const now = new Date().toISOString();
    const externalJobId = `sc_${createHash("sha256").update(parsed.idempotencyKey).digest("hex").slice(0, 20)}`;
    const job = await this.repo().create({
      externalJobId,
      applicationRequestId: parsed.requestId,
      uploadId: parsed.uploadId,
      ownerReference: parsed.ownerReference,
      idempotencyKey: parsed.idempotencyKey,
      requestFingerprint: fingerprint,
      contractVersion: parsed.contractVersion,
      submission: parsed,
      status: "queued",
      sequenceNumber: 1,
      attemptCount: 0,
      maxAttempts: REMOTE_MAX_ATTEMPTS,
      acceptedAt: now,
      retryable: false,
      createdAt: now,
      updatedAt: now,
    });
    logEvent("job_created", { applicationRequestId: job.applicationRequestId, externalJobId: job.externalJobId, uploadId: job.uploadId });
    return scottyProviderJobReceiptSchema.parse({
      contractVersion: job.contractVersion,
      provider: "scotty",
      externalJobId: job.externalJobId,
      applicationRequestId: job.applicationRequestId,
      idempotencyKey: job.idempotencyKey,
      acceptedAt: job.acceptedAt,
      status: job.status,
      pollAfterMs: SCOTTY_REMOTE_POLL_MS,
    });
  }

  private async requireJob(lookup: { externalJobId: string; applicationRequestId?: string }): Promise<ScottyWorkerJob> {
    const job = await this.repo().getByExternalJobId(lookup.externalJobId);
    if (!job) {
      throw new ProviderError("ANALYSIS_FAILED", "Unknown Scotty job.", "validation", { provider: "scotty", retryable: false });
    }
    if (lookup.applicationRequestId && lookup.applicationRequestId !== job.applicationRequestId) {
      throw new ProviderError("FORBIDDEN", "Request mismatch.", "authorization", { provider: "scotty", retryable: false });
    }
    return job;
  }

  async getJob(input: ScottyJobLookup): Promise<ScottyJobStatusResponse> {
    const job = await this.requireJob(input);
    const status = workerJobToStatus(job, SCOTTY_REMOTE_POLL_MS);
    return scottyJobStatusResponseSchema.parse({ ...status, provider: "scotty" });
  }

  async getReport(input: ScottyReportLookup): Promise<ScottyReport> {
    const job = await this.requireJob(input);
    if (job.status === "cancelled") {
      throw new ProviderError("JOB_CANCELLED", "This analysis job was cancelled.", "permanent_failure", { provider: "scotty", retryable: false });
    }
    if (job.status === "failed") {
      throw new ProviderError(job.errorCode ?? "ANALYSIS_FAILED", job.errorMessage ?? "Analysis failed.", "permanent_failure", {
        provider: "scotty",
        retryable: false,
      });
    }
    if (job.status !== "completed" || !job.report) {
      throw new ProviderError("REPORT_NOT_READY", "The coaching report is not ready yet.", "validation", { provider: "scotty", retryable: true });
    }
    return scottyReportSchema.parse(job.report);
  }

  async confirmPlayer(input: ScottyPlayerConfirmationSubmission): Promise<ScottyJobStatusResponse> {
    // Identity is confirmed on ChelCoach before submission and forwarded automatically by the
    // worker; a second, user-driven confirmation is accepted idempotently.
    const job = await this.requireJob(input);
    return this.getJob({ externalJobId: job.externalJobId, applicationRequestId: job.applicationRequestId });
  }

  async cancelJob(input: ScottyCancelRequest): Promise<ScottyCancelResponse> {
    const job = await this.requireJob(input);
    if (job.status === "completed") {
      throw new ProviderError("INVALID_REQUEST", "Completed jobs cannot be cancelled.", "validation", { provider: "scotty", retryable: false });
    }
    if (job.cancelledAt || job.status === "cancelled") {
      return scottyCancelResponseSchema.parse({ externalJobId: job.externalJobId, status: "cancelled", cancelledAt: job.cancelledAt ?? job.updatedAt });
    }
    const now = new Date().toISOString();
    const updated = await this.repo().update(job.externalJobId, {
      status: "cancelled",
      sequenceNumber: job.sequenceNumber + 1,
      cancelledAt: now,
      cancelReason: input.reason ?? "Cancelled by user",
      claimExpiresAt: undefined,
      workerId: undefined,
    });
    if (job.remote?.jobId && this.cfg.configured) {
      // Best effort: stop the gateway spending on a job nobody will read.
      await this.client().cancel(job.remote.jobId).catch(() => undefined);
    }
    logEvent("job_cancelled", { applicationRequestId: updated.applicationRequestId, externalJobId: updated.externalJobId });
    return scottyCancelResponseSchema.parse({ externalJobId: updated.externalJobId, status: "cancelled", cancelledAt: updated.cancelledAt ?? now });
  }

  async health(): Promise<ScottyProviderHealth> {
    const checkedAt = new Date().toISOString();
    if (!this.cfg.configured) {
      return scottyProviderHealthSchema.parse({
        provider: "scotty",
        configured: false,
        reachable: false,
        contractCompatible: true,
        status: "misconfigured",
        checkedAt,
        message: "SCOTTY_BASE_URL, SCOTTY_API_KEY and SCOTTY_SIGNING_SECRET are required",
      });
    }
    const ready = await this.client().health();
    const active = (await this.repo().listActive()).filter((j) => !isTerminalWorkerStatus(j.status)).length;
    return scottyProviderHealthSchema.parse({
      provider: "scotty",
      configured: true,
      reachable: ready.ok,
      contractCompatible: true,
      status: ready.ok ? (ready.provider === "fake" ? "degraded" : "healthy") : "unavailable",
      checkedAt,
      message: ready.ok
        ? `Scottie ready (gateway provider=${ready.provider ?? "unknown"}, ${active} active job${active === 1 ? "" : "s"})`
        : `Scottie unreachable (HTTP ${ready.status})`,
    });
  }
}
