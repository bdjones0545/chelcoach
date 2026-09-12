/**
 * The Scotty worker: claims durable jobs and runs the real analysis.
 *
 * One job runs end to end inside one claim — sample frames from the stored video (over a signed
 * URL, nothing downloaded), ask the vision model for the analysis, assemble and validate the
 * report, persist it. The scheduler calls `runScottyWorkerBatch` once a minute with a time
 * budget; a claim that outlives its lease (function killed mid-job) is picked up again on the
 * next tick until `maxAttempts` is exhausted. Every status change bumps the job's sequence
 * number so the application's sequence-safe sync sees a monotonic history.
 */
import { randomUUID } from "node:crypto";
import { getVisionModelClient, type ModelFrame, type VisionModelClient } from "../../ai/modelClient";
import { getFrameSampler, planSampleTimestamps, type FrameSampler } from "../../media/frameSampler";
import type { ScottyErrorCode, ScottyJobStatus } from "../../scottyContract";
import { getUploadRepository } from "../../uploads/repository";
import { ProviderError } from "../errors";
import { mechanicIds } from "./controlsKnowledge";
import { getScottyWorkerJobRepository, type ScottyWorkerJobRepository } from "./repository";
import { assembleScottyReport } from "./reportAssembler";
import type { ScottyWorkerJob } from "./types";

export const DEFAULT_WORKER_LEASE_MS = 5 * 60_000;
const DEFAULT_BUDGET_MS = 240_000;
const ANALYSIS_FRAME_MAX_EDGE = 1024;
const ANALYSIS_FRAME_MAX_BYTES = 700_000;

/** Errors that will not get better on a retry. */
const PERMANENT_CODES: ReadonlySet<string> = new Set([
  "UPLOAD_NOT_FOUND",
  "UPLOAD_EXPIRED",
  "MEDIA_ALREADY_DELETED",
  "VIDEO_DURATION_EXCEEDED",
  "PROVIDER_MISCONFIGURED",
  "JOB_CANCELLED",
]);

export interface ScottyWorkerResult {
  externalJobId: string;
  applicationRequestId: string;
  status: ScottyJobStatus;
  ok: boolean;
  errorCode?: string;
  elapsedMs: number;
}

export interface ScottyWorkerBatchResult {
  claimed: number;
  completed: number;
  failed: number;
  retried: number;
  skipped: number;
  results: ScottyWorkerResult[];
}

function logEvent(event: string, fields: Record<string, string | number | boolean | undefined>): void {
  const parts = Object.entries(fields)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${v}`);
  console.log(`[chelcoach-scotty-worker] event=${event} ${parts.join(" ")}`);
}

function backoffMs(attempt: number): number {
  return Math.min(10 * 60_000, 30_000 * 2 ** Math.max(0, attempt - 1));
}

function errorCodeOf(err: unknown): ScottyErrorCode {
  if (err instanceof ProviderError) return err.code;
  const code = (err as { code?: string }).code;
  const known: ScottyErrorCode[] = [
    "FRAME_EXTRACTION_FAILED",
    "REPORT_VALIDATION_FAILED",
    "UPLOAD_NOT_FOUND",
    "UPLOAD_EXPIRED",
    "MEDIA_ALREADY_DELETED",
    "VIDEO_FILE_TOO_LARGE",
    "STORAGE_OBJECT_NOT_FOUND",
    "STORAGE_ACCESS_DENIED",
    "STORAGE_UNAVAILABLE",
  ];
  return known.includes(code as ScottyErrorCode) ? (code as ScottyErrorCode) : "ANALYSIS_FAILED";
}

function isRetryable(err: unknown, code: ScottyErrorCode): boolean {
  if (PERMANENT_CODES.has(code)) return false;
  if (err instanceof ProviderError) return err.opts.retryable;
  // Sampling and storage hiccups are worth one more try; everything else is too.
  return true;
}

function safeMessageFor(code: ScottyErrorCode): string {
  switch (code) {
    case "UPLOAD_EXPIRED":
    case "MEDIA_ALREADY_DELETED":
      return "The source gameplay video is no longer available.";
    case "FRAME_EXTRACTION_FAILED":
      return "We couldn't read frames from this video.";
    case "REPORT_VALIDATION_FAILED":
      return "The coaching report did not pass validation.";
    case "PROVIDER_MISCONFIGURED":
      return "The analysis service is not configured.";
    case "RATE_LIMITED":
      return "The analysis service is busy. Your clip will be retried.";
    case "PROVIDER_UNAVAILABLE":
      return "The analysis service is temporarily unavailable.";
    default:
      return "Analysis could not be completed.";
  }
}

export interface ScottyWorkerDeps {
  repo?: ScottyWorkerJobRepository;
  sampler?: FrameSampler;
  model?: VisionModelClient;
  leaseMs?: number;
  now?: () => Date;
}

async function advance(
  repo: ScottyWorkerJobRepository,
  job: ScottyWorkerJob,
  status: ScottyJobStatus,
  extra: Partial<ScottyWorkerJob> = {},
): Promise<ScottyWorkerJob> {
  const next = await repo.update(job.externalJobId, {
    status,
    sequenceNumber: job.sequenceNumber + 1,
    ...extra,
  });
  logEvent("status_advanced", {
    applicationRequestId: next.applicationRequestId,
    externalJobId: next.externalJobId,
    status: next.status,
    sequenceNumber: next.sequenceNumber,
  });
  return next;
}

/** Run one claimed job to completion (or failure/retry). */
export async function processScottyWorkerJob(
  claimed: ScottyWorkerJob,
  deps: ScottyWorkerDeps = {},
): Promise<ScottyWorkerResult> {
  const repo = deps.repo ?? getScottyWorkerJobRepository();
  const sampler = deps.sampler ?? getFrameSampler();
  const model = deps.model ?? getVisionModelClient();
  const now = deps.now ?? (() => new Date());
  const started = Date.now();
  let job = claimed;

  try {
    // A cancellation that landed between claim and start wins.
    if (job.cancelledAt || job.status === "cancelled") {
      return { externalJobId: job.externalJobId, applicationRequestId: job.applicationRequestId, status: "cancelled", ok: false, errorCode: "JOB_CANCELLED", elapsedMs: 0 };
    }
    if (!model.configured) {
      throw new ProviderError("PROVIDER_MISCONFIGURED", "Vision model credentials are not configured.", "configuration", {
        provider: "scotty_worker",
        retryable: false,
      });
    }

    const upload = await getUploadRepository().get(job.uploadId);
    if (!upload) throw Object.assign(new Error("UPLOAD_NOT_FOUND"), { code: "UPLOAD_NOT_FOUND" });
    if (upload.uploadStatus === "deleted" || upload.deletedAt) {
      throw Object.assign(new Error("MEDIA_ALREADY_DELETED"), { code: "MEDIA_ALREADY_DELETED" });
    }
    if (upload.uploadStatus === "expired" || new Date(upload.absoluteDeleteAt).getTime() <= now().getTime()) {
      throw Object.assign(new Error("UPLOAD_EXPIRED"), { code: "UPLOAD_EXPIRED" });
    }

    const durationSec = job.submission.mediaMetadata.durationSec;
    const timestamps = planSampleTimestamps(durationSec);
    job = await advance(repo, job, "extracting_frames", { errorCode: undefined, errorMessage: undefined });
    const frames = await sampler.sample({
      objectKey: upload.storageObjectKey,
      timestampsSec: timestamps,
      maxEdge: ANALYSIS_FRAME_MAX_EDGE,
      maxBytes: ANALYSIS_FRAME_MAX_BYTES,
    });
    if (frames.length === 0) {
      throw Object.assign(new Error("FRAME_EXTRACTION_FAILED"), { code: "FRAME_EXTRACTION_FAILED" });
    }
    logEvent("frames_sampled", {
      applicationRequestId: job.applicationRequestId,
      externalJobId: job.externalJobId,
      frameCount: frames.length,
      durationSec: Math.round(durationSec),
    });

    job = await advance(repo, job, "analyzing_gameplay", { frameCount: frames.length });
    const modelFrames: ModelFrame[] = frames.map((f, index) => ({
      index,
      timestampSec: f.timestampSec,
      jpegBase64: f.bytes.toString("base64"),
    }));
    const e = job.submission.effectivePlayer;
    const { output, usage } = await model.analyzeGameplay({
      frames: modelFrames,
      context: {
        gameContext: job.submission.gameContext,
        playerContext: job.submission.playerContext,
        effectivePlayer: {
          position: e.position,
          jerseyNumber: e.jerseyNumber,
          indicatorColor: e.indicatorColor,
          teamSide: e.teamSide,
          userConfirmed: e.userConfirmed,
        },
        durationSec,
        mediaClassification: job.submission.mediaClassification,
        mechanicIds: mechanicIds(),
      },
    });
    logEvent("model_analysis_completed", {
      applicationRequestId: job.applicationRequestId,
      externalJobId: job.externalJobId,
      model: usage.model,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
    });

    job = await advance(repo, job, "validating_report", {
      modelUsage: {
        model: usage.model,
        calls: (job.modelUsage?.calls ?? 0) + 1,
        inputTokens: (job.modelUsage?.inputTokens ?? 0) + usage.inputTokens,
        outputTokens: (job.modelUsage?.outputTokens ?? 0) + usage.outputTokens,
      },
    });
    const assembled = assembleScottyReport({
      externalJobId: job.externalJobId,
      submission: job.submission,
      frameTimestampsSec: frames.map((f) => f.timestampSec),
      output,
      now: now(),
    });
    if (assembled.issues.length > 0) {
      logEvent("report_quality_issues", {
        applicationRequestId: job.applicationRequestId,
        externalJobId: job.externalJobId,
        issueCount: assembled.issues.length,
      });
    }

    // Re-check cancellation before publishing the report.
    const latest = await repo.getByExternalJobId(job.externalJobId);
    if (latest?.cancelledAt || latest?.status === "cancelled") {
      return { externalJobId: job.externalJobId, applicationRequestId: job.applicationRequestId, status: "cancelled", ok: false, errorCode: "JOB_CANCELLED", elapsedMs: Date.now() - started };
    }
    job = await advance(repo, job, "completed", {
      report: assembled.report,
      completedAt: now().toISOString(),
      claimExpiresAt: undefined,
      workerId: undefined,
      retryable: false,
    });
    logEvent("job_completed", {
      applicationRequestId: job.applicationRequestId,
      externalJobId: job.externalJobId,
      observations: assembled.report.playerSpecificObservations.length,
      elapsedMs: Date.now() - started,
    });
    return { externalJobId: job.externalJobId, applicationRequestId: job.applicationRequestId, status: "completed", ok: true, elapsedMs: Date.now() - started };
  } catch (err) {
    const code = errorCodeOf(err);
    const retryable = isRetryable(err, code);
    const current = (await repo.getByExternalJobId(job.externalJobId)) ?? job;
    if (current.cancelledAt || current.status === "cancelled") {
      return { externalJobId: job.externalJobId, applicationRequestId: job.applicationRequestId, status: "cancelled", ok: false, errorCode: "JOB_CANCELLED", elapsedMs: Date.now() - started };
    }
    const detail = (err as { detail?: string }).detail ?? (err instanceof Error ? err.message : String(err));
    logEvent("job_error", {
      applicationRequestId: job.applicationRequestId,
      externalJobId: job.externalJobId,
      errorCode: code,
      retryable,
      attempt: current.attemptCount,
      detail: detail.replace(/https?:\/\/\S+/g, "[url]").slice(0, 200),
    });

    if (retryable && current.attemptCount < current.maxAttempts) {
      const next = new Date(now().getTime() + backoffMs(current.attemptCount)).toISOString();
      await repo.update(job.externalJobId, {
        status: "queued",
        sequenceNumber: current.sequenceNumber + 1,
        claimExpiresAt: undefined,
        workerId: undefined,
        nextAttemptAt: next,
        retryable: true,
        errorCode: code,
        errorMessage: safeMessageFor(code),
      });
      return { externalJobId: job.externalJobId, applicationRequestId: job.applicationRequestId, status: "queued", ok: false, errorCode: code, elapsedMs: Date.now() - started };
    }

    await repo.update(job.externalJobId, {
      status: "failed",
      sequenceNumber: current.sequenceNumber + 1,
      claimExpiresAt: undefined,
      workerId: undefined,
      failedAt: now().toISOString(),
      retryable: false,
      errorCode: code,
      errorMessage: safeMessageFor(code),
    });
    return { externalJobId: job.externalJobId, applicationRequestId: job.applicationRequestId, status: "failed", ok: false, errorCode: code, elapsedMs: Date.now() - started };
  }
}

/**
 * Claim and process jobs until the batch limit or time budget is reached. A job is only claimed
 * when the remaining budget could plausibly complete it, so a scheduler tick never starts work
 * it is about to abandon.
 */
export async function runScottyWorkerBatch(
  input: { workerId?: string; limit?: number; budgetMs?: number } = {},
  deps: ScottyWorkerDeps = {},
): Promise<ScottyWorkerBatchResult> {
  const repo = deps.repo ?? getScottyWorkerJobRepository();
  const now = deps.now ?? (() => new Date());
  const workerId = input.workerId ?? `worker-${randomUUID().slice(0, 8)}`;
  const limit = Math.max(1, Math.min(input.limit ?? 2, 10));
  const budgetMs = input.budgetMs ?? DEFAULT_BUDGET_MS;
  const minPerJobMs = Math.min(90_000, budgetMs);
  const started = Date.now();
  const result: ScottyWorkerBatchResult = { claimed: 0, completed: 0, failed: 0, retried: 0, skipped: 0, results: [] };

  for (let i = 0; i < limit; i++) {
    if (Date.now() - started > budgetMs - minPerJobMs) break;
    const claimed = await repo.claimNext({ workerId, now: now(), leaseMs: deps.leaseMs ?? DEFAULT_WORKER_LEASE_MS });
    if (!claimed) break;
    result.claimed += 1;
    const r = await processScottyWorkerJob(claimed, deps);
    result.results.push(r);
    if (r.ok) result.completed += 1;
    else if (r.status === "queued") result.retried += 1;
    else if (r.status === "cancelled") result.skipped += 1;
    else result.failed += 1;
  }
  return result;
}
