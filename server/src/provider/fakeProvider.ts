/**
 * Minimal deterministic FakeScottyProvider — proves the provider boundary.
 * Full lifecycle simulator remains Step 5.
 */
import { createHash } from "node:crypto";
import {
  minimalScottyReport,
  scottyJobStatusResponseSchema,
  scottyProviderHealthSchema,
  scottyProviderJobReceiptSchema,
  scottyReportSchema,
  type ScottyAnalysisSubmission,
  type ScottyCancelRequest,
  type ScottyCancelResponse,
  type ScottyJobLookup,
  type ScottyJobStatusResponse,
  type ScottyProviderHealth,
  type ScottyProviderJobReceipt,
  type ScottyReport,
  type ScottyReportLookup,
} from "../scottyContract";
import type { FakeProviderScenario } from "./config";
import { ProviderError } from "./errors";
import type { ScottyProvider } from "./types";

interface StoredJob {
  submission: ScottyAnalysisSubmission;
  fingerprint: string;
  receipt: ScottyProviderJobReceipt;
  status: ScottyJobStatusResponse["status"];
  report?: ScottyReport;
}

function hashFingerprint(parts: unknown): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 32);
}

export function computeSubmissionFingerprint(sub: ScottyAnalysisSubmission): string {
  // Exclude mediaTransfer (may hold transient URL refs) and timestamps.
  return hashFingerprint({
    uploadId: sub.uploadId,
    gameContext: sub.gameContext,
    effectivePlayer: sub.effectivePlayer,
    capabilities: sub.capabilities,
    mediaClassification: sub.mediaClassification,
    contractVersion: sub.contractVersion.split(".")[0],
  });
}

export class FakeScottyProvider implements ScottyProvider {
  readonly mode = "fake" as const;
  // Deterministic fixtures for dev/CI only — never real analysis.
  readonly canServeProductionTraffic = false;
  private jobs = new Map<string, StoredJob>();
  private byIdempotency = new Map<string, string>();

  constructor(private scenario: FakeProviderScenario = "accept") {}

  setScenario(scenario: FakeProviderScenario): void {
    this.scenario = scenario;
  }

  clear(): void {
    this.jobs.clear();
    this.byIdempotency.clear();
  }

  async submitAnalysis(input: ScottyAnalysisSubmission): Promise<ScottyProviderJobReceipt> {
    if (this.scenario === "timeout") {
      throw new ProviderError("ANALYSIS_TIMEOUT", "Fake provider timed out.", "timeout", {
        provider: "fake",
        retryable: true,
        requestId: input.requestId,
      });
    }
    if (this.scenario === "invalid_response") {
      // Intentionally return unvalidated shape — caller must reject.
      return {
        contractVersion: "not-semver",
        provider: "fake",
        externalJobId: "bad",
        applicationRequestId: input.requestId,
        idempotencyKey: input.idempotencyKey,
        acceptedAt: "not-a-date",
        status: "queued",
      } as unknown as ScottyProviderJobReceipt;
    }
    if (this.scenario === "failed") {
      throw new ProviderError("ANALYSIS_FAILED", "Fake provider rejected analysis.", "permanent_failure", {
        provider: "fake",
        retryable: false,
        requestId: input.requestId,
      });
    }

    const fingerprint = computeSubmissionFingerprint(input);
    const existingId = this.byIdempotency.get(input.idempotencyKey);
    if (existingId) {
      const existing = this.jobs.get(existingId)!;
      if (existing.fingerprint !== fingerprint) {
        throw new ProviderError(
          "IDEMPOTENCY_CONFLICT",
          "Idempotency key reused with different request fingerprint.",
          "validation",
          { provider: "fake", retryable: false, requestId: input.requestId },
        );
      }
      return scottyProviderJobReceiptSchema.parse(existing.receipt);
    }

    const externalJobId = `fake_${createHash("sha256").update(input.idempotencyKey).digest("hex").slice(0, 16)}`;
    const acceptedAt = new Date().toISOString();
    const status = this.scenario === "completed" ? "completed" : "queued";
    const receipt = scottyProviderJobReceiptSchema.parse({
      contractVersion: input.contractVersion,
      provider: "fake",
      externalJobId,
      applicationRequestId: input.requestId,
      idempotencyKey: input.idempotencyKey,
      acceptedAt,
      status,
      pollAfterMs: 1000,
      providerTraceId: `trace_${externalJobId}`,
    });

    let report: ScottyReport | undefined;
    if (status === "completed") {
      report = scottyReportSchema.parse(
        minimalScottyReport({
          jobId: externalJobId,
          uploadId: input.uploadId,
          gameContext: input.gameContext,
          playerAttribution: {
            position: input.effectivePlayer.position,
            jerseyNumber: input.effectivePlayer.jerseyNumber,
            indicatorColor: input.effectivePlayer.indicatorColor,
            confirmationState: input.effectivePlayer.userConfirmed ? "confirmed" : "auto_accepted",
          },
        }),
      );
    }

    this.jobs.set(externalJobId, {
      submission: input,
      fingerprint,
      receipt,
      status,
      report,
    });
    this.byIdempotency.set(input.idempotencyKey, externalJobId);
    return receipt;
  }

  async getJob(input: ScottyJobLookup): Promise<ScottyJobStatusResponse> {
    const job = this.jobs.get(input.externalJobId);
    if (!job) {
      throw new ProviderError("ANALYSIS_FAILED", "Unknown fake job.", "validation", {
        provider: "fake",
        retryable: false,
      });
    }
    return scottyJobStatusResponseSchema.parse({
      contractVersion: job.receipt.contractVersion,
      jobId: job.receipt.externalJobId,
      uploadId: job.submission.uploadId,
      provider: "fake",
      externalScottyJobId: job.receipt.externalJobId,
      status: job.status,
      reportReady: job.status === "completed",
      updatedAt: new Date().toISOString(),
    });
  }

  async getReport(input: ScottyReportLookup): Promise<ScottyReport> {
    const job = this.jobs.get(input.externalJobId);
    if (!job?.report) {
      throw new ProviderError("REPORT_VALIDATION_FAILED", "Report not ready.", "invalid_response", {
        provider: "fake",
        retryable: false,
      });
    }
    return scottyReportSchema.parse(job.report);
  }

  async cancelJob(input: ScottyCancelRequest): Promise<ScottyCancelResponse> {
    const job = this.jobs.get(input.externalJobId);
    if (job) job.status = "cancelled";
    return {
      externalJobId: input.externalJobId,
      status: "cancelled",
      cancelledAt: new Date().toISOString(),
    };
  }

  async health(): Promise<ScottyProviderHealth> {
    return scottyProviderHealthSchema.parse({
      provider: "fake",
      configured: true,
      reachable: true,
      contractCompatible: true,
      status: "healthy",
      checkedAt: new Date().toISOString(),
      message: "Fake provider ready",
    });
  }
}
