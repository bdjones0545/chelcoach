/**
 * Scheduler-driven work for provider mode `scotty` (Scottie on orgo-desktop).
 *
 * A claimed row is in one of two states:
 *   not yet dispatched — sample ≤12 frames over the signed URL, POST them to Scottie, record the
 *                        remote job; nothing else is retried on failure except by the next tick;
 *   dispatched         — poll Scottie once: forward ChelCoach's confirmed identity if the gateway
 *                        pauses for confirmation, map a finished report onto the contract, mirror
 *                        failures. Polling never counts against the attempt budget.
 *
 * Status names are shared with the gateway, so the row mirrors Scottie's stage 1:1 and the
 * application's sequence-safe sync sees a monotonic history.
 */
import { getFrameSampler, planSampleTimestamps, type FrameSampler } from "../../media/frameSampler";
import { getUploadRepository } from "../../uploads/repository";
import type { ScottyErrorCode, ScottyJobStatus } from "../../scottyContract";
import { ProviderError } from "../errors";
import { getScottyWorkerJobRepository, type ScottyWorkerJobRepository } from "../scottyWorker/repository";
import type { ScottyWorkerJob } from "../scottyWorker/types";
import type { ScottyWorkerBatchResult, ScottyWorkerResult } from "../scottyWorker/worker";
import { DEFAULT_WORKER_LEASE_MS } from "../scottyWorker/worker";
import { ScottieClient, type ScottieJob } from "./client";
import { loadScottyRemoteConfig } from "./provider";
import { mapScottieReport } from "./reportMapper";

const MAX_REMOTE_FRAMES = 12;
const REMOTE_FRAME_MAX_EDGE = 1024;
const REMOTE_FRAME_MAX_BYTES = 1_200_000;
const REMOTE_TOTAL_BYTES = 10_000_000;
const REMOTE_JOB_TIMEOUT_MS = 30 * 60_000;

const STATUSES: ReadonlySet<string> = new Set([
  "queued",
  "inspecting_input",
  "extracting_frames",
  "identifying_controlled_player",
  "awaiting_player_confirmation",
  "validating_player_identity",
  "analyzing_gameplay",
  "validating_report",
  "finalizing",
  "completed",
  "failed",
  "cancelled",
]);

function logEvent(event: string, fields: Record<string, string | number | boolean | undefined>): void {
  const parts = Object.entries(fields)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${v}`);
  console.log(`[chelcoach-scotty-remote] event=${event} ${parts.join(" ")}`);
}

function mapRemoteErrorCode(code: unknown): ScottyErrorCode {
  const c = String(code ?? "").toLowerCase();
  if (c === "cancelled") return "JOB_CANCELLED";
  if (c === "player_identity_unconfirmed") return "PLAYER_IDENTITY_UNCONFIRMED";
  if (c === "invalid_report" || c === "attribution_failed" || c === "invalid_identity_schema") return "REPORT_VALIDATION_FAILED";
  if (c === "provider_failure") return "PROVIDER_UNAVAILABLE";
  if (c === "invalid_input") return "INVALID_REQUEST";
  return "ANALYSIS_FAILED";
}

function safeMessage(code: ScottyErrorCode): string {
  switch (code) {
    case "REPORT_VALIDATION_FAILED":
      return "Scottie's report did not pass the quality gate.";
    case "PROVIDER_UNAVAILABLE":
      return "Scottie's analysis model was unavailable. Your clip will be retried.";
    case "ANALYSIS_TIMEOUT":
      return "Scottie did not finish in time.";
    case "PLAYER_IDENTITY_UNCONFIRMED":
      return "Scottie could not confirm the controlled player.";
    case "INVALID_REQUEST":
      return "Scottie rejected the sampled frames.";
    case "PROVIDER_MISCONFIGURED":
      return "The Scottie connection is not configured.";
    default:
      return "Analysis could not be completed.";
  }
}

export interface ScottyRemoteDeps {
  repo?: ScottyWorkerJobRepository;
  sampler?: FrameSampler;
  client?: ScottieClient;
  now?: () => Date;
  leaseMs?: number;
}

async function setStatus(repo: ScottyWorkerJobRepository, job: ScottyWorkerJob, status: ScottyJobStatus, extra: Partial<ScottyWorkerJob> = {}): Promise<ScottyWorkerJob> {
  if (job.status === status && Object.keys(extra).length === 0) return job;
  const next = await repo.update(job.externalJobId, {
    ...(job.status === status ? {} : { status, sequenceNumber: job.sequenceNumber + 1 }),
    ...extra,
  });
  if (job.status !== status) {
    logEvent("status_advanced", { applicationRequestId: next.applicationRequestId, externalJobId: next.externalJobId, status, sequenceNumber: next.sequenceNumber });
  }
  return next;
}

function release(job: ScottyWorkerJob): Partial<ScottyWorkerJob> {
  void job;
  return { claimExpiresAt: undefined, workerId: undefined };
}

/** Confirmed identity as the gateway's confirm-player endpoint expects it. */
export function identityConfirmationFor(job: ScottyWorkerJob): Record<string, unknown> {
  const e = job.submission.effectivePlayer;
  return {
    jerseyNumber: e.jerseyNumber,
    indicatorColor: e.indicatorColor,
    position: e.position,
    teamSide: e.teamSide,
    confidence: Math.max(0.9, e.confidence),
    evidenceSummary: [e.userConfirmed ? "user_confirmed_in_chelcoach" : "high_confidence_identification_in_chelcoach"],
  };
}

export function gameplayContextFor(job: ScottyWorkerJob): Record<string, unknown> {
  const s = job.submission;
  const e = s.effectivePlayer;
  return {
    gameTitle: s.gameContext.selectedGameTitle,
    canonicalGameId: s.gameContext.canonicalGameId,
    gameMode: s.playerContext.gameMode,
    platform: s.playerContext.platform,
    controlScheme: s.playerContext.controlScheme,
    position: e.position,
    teamSide: e.teamSide,
    jerseyNumber: e.jerseyNumber,
    indicatorColor: e.indicatorColor,
    singlePlayerControl: true,
    playerContext: { ...s.playerContext, position: e.position, teamSide: e.teamSide, jerseyNumber: e.jerseyNumber, indicatorColor: e.indicatorColor, gameTitle: s.gameContext.selectedGameTitle },
    controlledPlayer: {
      controlledPlayerDetected: true,
      confidence: Math.max(0.9, e.confidence),
      position: e.position,
      jerseyNumber: e.jerseyNumber,
      indicatorColor: e.indicatorColor,
      teamSide: e.teamSide,
      identitySource: e.userConfirmed ? "user_confirmed" : "visual_verified",
      userConfirmed: e.userConfirmed,
    },
    mediaClassification: s.mediaClassification,
  };
}

async function dispatch(job: ScottyWorkerJob, deps: Required<Pick<ScottyRemoteDeps, "repo" | "sampler" | "client" | "now">>): Promise<ScottyWorkerJob> {
  const upload = await getUploadRepository().get(job.uploadId);
  if (!upload) throw Object.assign(new Error("UPLOAD_NOT_FOUND"), { code: "UPLOAD_NOT_FOUND" });
  if (upload.uploadStatus === "deleted" || upload.deletedAt) throw Object.assign(new Error("MEDIA_ALREADY_DELETED"), { code: "MEDIA_ALREADY_DELETED" });
  if (upload.uploadStatus === "expired") throw Object.assign(new Error("UPLOAD_EXPIRED"), { code: "UPLOAD_EXPIRED" });

  const durationSec = job.submission.mediaMetadata.durationSec;
  job = await setStatus(deps.repo, job, "extracting_frames", { errorCode: undefined, errorMessage: undefined });
  const timestamps = planSampleTimestamps(durationSec, { minFrames: Math.min(6, MAX_REMOTE_FRAMES), maxFrames: MAX_REMOTE_FRAMES });
  const frames = await deps.sampler.sample({ objectKey: upload.storageObjectKey, timestampsSec: timestamps, maxEdge: REMOTE_FRAME_MAX_EDGE, maxBytes: REMOTE_FRAME_MAX_BYTES });
  const kept: typeof frames = [];
  let total = 0;
  for (const f of frames) {
    if (total + f.bytes.length > REMOTE_TOTAL_BYTES) break;
    total += f.bytes.length;
    kept.push(f);
  }
  if (kept.length === 0) throw Object.assign(new Error("FRAME_EXTRACTION_FAILED"), { code: "FRAME_EXTRACTION_FAILED" });

  const s = job.submission;
  const remoteJob = await deps.client.analyze({
    jobId: job.externalJobId,
    clipId: job.uploadId,
    idempotencyKey: job.idempotencyKey,
    metadata: {
      durationSec,
      width: s.mediaMetadata.width,
      height: s.mediaMetadata.height,
      fps: s.mediaMetadata.fps ?? null,
      mediaClassification: s.mediaClassification,
      frameCount: kept.length,
      gameTitle: s.gameContext.selectedGameTitle,
      gameMode: s.playerContext.gameMode,
      platform: s.playerContext.platform,
      controlScheme: s.playerContext.controlScheme,
    },
    gameplayContext: gameplayContextFor(job),
    frames: kept.map((f) => ({ timestamp: f.timestampSec, jpegBase64: f.bytes.toString("base64") })),
  });
  const nowIso = deps.now().toISOString();
  logEvent("dispatched", { applicationRequestId: job.applicationRequestId, externalJobId: job.externalJobId, remoteJobId: remoteJob.jobId, frames: kept.length, remoteStatus: remoteJob.status, deduplicated: remoteJob.deduplicated === true });
  const status = STATUSES.has(remoteJob.status) ? (remoteJob.status as ScottyJobStatus) : "analyzing_gameplay";
  return setStatus(deps.repo, job, status === "queued" ? "inspecting_input" : status, {
    frameCount: kept.length,
    remote: {
      jobId: remoteJob.jobId || job.externalJobId,
      dispatchedAt: nowIso,
      frameTimestampsSec: kept.map((f) => f.timestampSec),
      remoteStatus: remoteJob.status,
      lastPolledAt: nowIso,
    },
    ...release(job),
  });
}

async function poll(job: ScottyWorkerJob, deps: Required<Pick<ScottyRemoteDeps, "repo" | "client" | "now">>): Promise<ScottyWorkerJob> {
  const remote = job.remote!;
  const nowIso = deps.now().toISOString();
  const elapsed = deps.now().getTime() - new Date(remote.dispatchedAt).getTime();
  const rj: ScottieJob = await deps.client.getJob(remote.jobId);
  const remoteStatus = String(rj.status ?? "");
  const patchRemote = { ...remote, remoteStatus, lastPolledAt: nowIso };

  if (remoteStatus === "completed" || rj.report) {
    const full = rj.report ? rj : await deps.client.getReport(remote.jobId);
    const mapped = mapScottieReport({
      externalJobId: job.externalJobId,
      submission: job.submission,
      report: (full.report ?? {}) as Record<string, unknown>,
      controlledPlayer: full.controlledPlayer,
      providerMetadata: full.providerMetadata,
      frameTimestampsSec: remote.frameTimestampsSec,
      now: deps.now(),
    });
    if (mapped.issues.length) logEvent("report_quality_issues", { applicationRequestId: job.applicationRequestId, externalJobId: job.externalJobId, issueCount: mapped.issues.length });
    logEvent("job_completed", { applicationRequestId: job.applicationRequestId, externalJobId: job.externalJobId, observations: mapped.report.playerSpecificObservations.length, elapsedMs: elapsed });
    return setStatus(deps.repo, job, "completed", { report: mapped.report, completedAt: nowIso, retryable: false, remote: patchRemote, ...release(job) });
  }

  if (remoteStatus === "failed") {
    const code = mapRemoteErrorCode(rj.errorCode);
    if (code === "JOB_CANCELLED") {
      return setStatus(deps.repo, job, "cancelled", { cancelledAt: nowIso, cancelReason: "Cancelled at the gateway", remote: patchRemote, ...release(job) });
    }
    logEvent("job_failed_remote", { applicationRequestId: job.applicationRequestId, externalJobId: job.externalJobId, errorCode: code, remoteError: String(rj.errorCode ?? "") });
    return setStatus(deps.repo, job, "failed", { failedAt: nowIso, errorCode: code, errorMessage: safeMessage(code), retryable: false, remote: patchRemote, ...release(job) });
  }

  if (remoteStatus === "awaiting_player_confirmation") {
    if (!remote.autoConfirmedAt) {
      // The user already confirmed the skater in ChelCoach; forward that once so the gateway
      // resumes instead of waiting on a second confirmation nobody will give.
      const resumed = await deps.client.confirmPlayer(remote.jobId, identityConfirmationFor(job));
      logEvent("identity_forwarded", { applicationRequestId: job.applicationRequestId, externalJobId: job.externalJobId, remoteStatus: String(resumed.status ?? "") });
      return setStatus(deps.repo, job, "validating_player_identity", { remote: { ...patchRemote, autoConfirmedAt: nowIso, remoteStatus: String(resumed.status ?? "") }, ...release(job) });
    }
    // Forwarded once already and still paused — that is a real identity failure at the gateway.
    return setStatus(deps.repo, job, "failed", { failedAt: nowIso, errorCode: "PLAYER_IDENTITY_UNCONFIRMED", errorMessage: safeMessage("PLAYER_IDENTITY_UNCONFIRMED"), retryable: false, remote: patchRemote, ...release(job) });
  }

  if (elapsed > REMOTE_JOB_TIMEOUT_MS) {
    await deps.client.cancel(remote.jobId).catch(() => undefined);
    return setStatus(deps.repo, job, "failed", { failedAt: nowIso, errorCode: "ANALYSIS_TIMEOUT", errorMessage: safeMessage("ANALYSIS_TIMEOUT"), retryable: false, remote: patchRemote, ...release(job) });
  }

  const local = STATUSES.has(remoteStatus) && remoteStatus !== "queued" ? (remoteStatus as ScottyJobStatus) : job.status;
  return setStatus(deps.repo, job, local, { remote: patchRemote, ...release(job) });
}

export async function processRemoteScottyJob(claimed: ScottyWorkerJob, deps: ScottyRemoteDeps = {}): Promise<ScottyWorkerResult> {
  const repo = deps.repo ?? getScottyWorkerJobRepository();
  const sampler = deps.sampler ?? getFrameSampler();
  const client = deps.client ?? new ScottieClient(loadScottyRemoteConfig());
  const now = deps.now ?? (() => new Date());
  const started = Date.now();
  const job = claimed;
  const result = (status: ScottyJobStatus, ok: boolean, errorCode?: string): ScottyWorkerResult => ({
    externalJobId: job.externalJobId,
    applicationRequestId: job.applicationRequestId,
    status,
    ok,
    errorCode,
    elapsedMs: Date.now() - started,
  });

  try {
    if (job.cancelledAt || job.status === "cancelled") return result("cancelled", false, "JOB_CANCELLED");
    const next = job.remote ? await poll(job, { repo, client, now }) : await dispatch(job, { repo, sampler, client, now });
    return result(next.status, next.status === "completed", next.errorCode);
  } catch (err) {
    const current = (await repo.getByExternalJobId(job.externalJobId)) ?? job;
    if (current.cancelledAt || current.status === "cancelled") return result("cancelled", false, "JOB_CANCELLED");
    const code: ScottyErrorCode = err instanceof ProviderError ? err.code : ((err as { code?: string }).code as ScottyErrorCode) ?? "ANALYSIS_FAILED";
    const permanent =
      ["UPLOAD_NOT_FOUND", "UPLOAD_EXPIRED", "MEDIA_ALREADY_DELETED", "PROVIDER_MISCONFIGURED", "INVALID_REQUEST", "REPORT_VALIDATION_FAILED"].includes(code) ||
      (err instanceof ProviderError && !err.opts.retryable && err.code !== "REPORT_NOT_READY");
    const detail = ((err as { detail?: string }).detail ?? (err instanceof Error ? err.message : String(err))).replace(/https?:\/\/\S+/g, "[url]").slice(0, 200);
    logEvent("job_error", { applicationRequestId: job.applicationRequestId, externalJobId: job.externalJobId, errorCode: code, permanent, dispatched: Boolean(current.remote), attempt: current.attemptCount, detail });

    if (permanent || (!current.remote && current.attemptCount >= 3)) {
      await repo.update(job.externalJobId, { status: "failed", sequenceNumber: current.sequenceNumber + 1, failedAt: now().toISOString(), retryable: false, errorCode: code, errorMessage: safeMessage(code), ...release(job) });
      return result("failed", false, code);
    }
    // Transient: release the claim and let the next tick retry (dispatch backs off; polls just wait).
    const backoffMs = current.remote ? 0 : Math.min(10 * 60_000, 30_000 * 2 ** Math.max(0, current.attemptCount - 1));
    await repo.update(job.externalJobId, { ...(current.remote ? {} : { status: "queued", sequenceNumber: current.sequenceNumber + 1 }), nextAttemptAt: new Date(now().getTime() + backoffMs).toISOString(), retryable: true, errorCode: code, errorMessage: safeMessage(code), ...release(job) });
    return result(current.remote ? current.status : "queued", false, code);
  }
}

/** Claim-and-process loop for remote jobs; same shape as the in-process batch. */
export async function runRemoteScottyBatch(input: { workerId?: string; limit?: number; budgetMs?: number } = {}, deps: ScottyRemoteDeps = {}): Promise<ScottyWorkerBatchResult> {
  const repo = deps.repo ?? getScottyWorkerJobRepository();
  const now = deps.now ?? (() => new Date());
  const workerId = input.workerId ?? `remote-${Math.random().toString(16).slice(2, 10)}`;
  const limit = Math.max(1, Math.min(input.limit ?? 10, 25));
  const budgetMs = input.budgetMs ?? 240_000;
  const started = Date.now();
  const out: ScottyWorkerBatchResult = { claimed: 0, completed: 0, failed: 0, retried: 0, skipped: 0, results: [] };
  // One touch per job per tick: a polled job is claimable again the moment its claim is released,
  // and the tick must not spin on it.
  const touched = new Set<string>();
  for (let i = 0; i < limit; i++) {
    if (Date.now() - started > budgetMs - 60_000) break;
    const claimed = await repo.claimNext({ workerId, now: now(), leaseMs: deps.leaseMs ?? DEFAULT_WORKER_LEASE_MS });
    if (!claimed) break;
    if (touched.has(claimed.externalJobId)) {
      await repo.update(claimed.externalJobId, { claimExpiresAt: undefined, workerId: undefined, attemptCount: claimed.attemptCount - 1 });
      break;
    }
    touched.add(claimed.externalJobId);
    out.claimed += 1;
    const r = await processRemoteScottyJob(claimed, deps);
    out.results.push(r);
    if (r.ok) out.completed += 1;
    else if (r.status === "failed") out.failed += 1;
    else if (r.status === "cancelled") out.skipped += 1;
    else out.retried += 1;
  }
  return out;
}
