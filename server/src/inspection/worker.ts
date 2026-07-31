/**
 * Media inspection worker (Step 10.1D).
 *
 * Placement: dedicated always-on process (Scotty VM or media worker VM).
 * Transport: database-claim model with atomic SKIP LOCKED claims.
 * Storage access: service-role Supabase client via SupabaseMediaObjectStorage
 *   (never logs signed URLs / credentials).
 *
 * Does NOT run inside Vercel Functions.
 * Does NOT start gameplay analysis.
 */
import { spawn } from "node:child_process";
import { createWriteStream, promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { PassThrough, Readable } from "node:stream";
import {
  assertDurationAllowed,
  classifyMediaDuration,
  pollAfterMsForInspection,
  publicInspectionMessage,
  RETENTION_POLICY_VERSION,
  calculateAbsoluteDeleteAt,
  calculateExpiresAt,
  SCOTTY_MAX_DURATION_SEC,
  type MediaClassification,
  type PublicInspectionSummary,
  type ScottyErrorCode,
} from "../scottyContract";
import { getMediaObjectStorage } from "../mediaStorage";
import { getMediaRetentionPolicy, getMaxUploadBytes } from "../retention/policy";
import { getUploadRepository } from "../uploads/repository";
import { assertUploadTransition } from "../uploads/transitions";
import { getInspectionJobRepository } from "./repository";
import type { MediaInspectionJobRecord, MediaInspectionWorkerResult } from "./types";

const DEFAULT_LEASE_MS = 5 * 60_000;
const DISK_SAFETY_MARGIN_BYTES = 256 * 1024 * 1024;
const FFPROBE_TIMEOUT_MS = 60_000;
const MAX_STDOUT = 256_000;
const MAX_STDERR = 16_000;

const PERMANENT_ERRORS = new Set([
  "VIDEO_DURATION_EXCEEDED",
  "UNSUPPORTED_MEDIA_TYPE",
  "NO_VIDEO_STREAM",
  "STORAGE_OBJECT_MISMATCH",
  "VIDEO_FILE_TOO_LARGE",
]);

export type MediaInspectionWorker = {
  claimNext(input: { workerId: string; now: Date }): Promise<MediaInspectionJobRecord | null>;
  process(input: { workerId: string; jobId: string }): Promise<MediaInspectionWorkerResult>;
  runBatch(input: {
    workerId: string;
    limit: number;
  }): Promise<{ processed: number; results: MediaInspectionWorkerResult[] }>;
  heartbeat(input: { workerId: string; jobId: string; leaseMs?: number }): Promise<void>;
};

function logEvent(event: string, fields: Record<string, string | number | boolean | undefined>): void {
  const parts = Object.entries(fields)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${v}`);
  console.log(`[chelcoach-inspection-worker] event=${event} ${parts.join(" ")}`);
}

function parseFps(rate: string | undefined): number | undefined {
  if (!rate || rate === "0/0") return undefined;
  const [a, b] = rate.split("/").map(Number);
  if (!b) return Number.isFinite(a) ? a : undefined;
  return b === 0 ? undefined : a / b;
}

async function availableDiskBytes(dir: string): Promise<number> {
  try {
    const st = await fs.statfs(dir);
    return Number(st.bavail) * Number(st.bsize);
  } catch {
    // Older Node without statfs — best-effort allow.
    return Number.MAX_SAFE_INTEGER;
  }
}

async function runFfprobeJson(filePath: string, timeoutMs = FFPROBE_TIMEOUT_MS): Promise<unknown> {
  const ffprobe = process.env.FFPROBE_PATH?.trim() || "ffprobe";
  return new Promise((resolve, reject) => {
    const child = spawn(
      ffprobe,
      [
        "-v",
        "error",
        "-show_entries",
        "stream=codec_type,codec_name,width,height,avg_frame_rate,side_data:format=format_name,duration,size",
        "-of",
        "json",
        filePath,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(Object.assign(new Error("ffprobe timeout"), { code: "INSPECTION_TIMEOUT" }));
    }, timeoutMs);
    child.stdout.on("data", (c: Buffer) => {
      if (stdout.length < MAX_STDOUT) stdout += c.toString("utf8");
    });
    child.stderr.on("data", (c: Buffer) => {
      if (stderr.length < MAX_STDERR) stderr += c.toString("utf8");
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(Object.assign(err, { code: "WORKER_UNAVAILABLE" }));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(
          Object.assign(new Error("ffprobe failed"), {
            code: "MEDIA_INSPECTION_FAILED",
            // Truncated sanitized diagnostic — never returned to users.
            diagnostic: stderr.slice(0, 500),
          }),
        );
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch {
        reject(Object.assign(new Error("invalid ffprobe JSON"), { code: "MEDIA_INSPECTION_FAILED" }));
      }
    });
  });
}

function backoffMs(attempt: number): number {
  const base = Math.min(60_000, 1000 * 2 ** Math.max(0, attempt - 1));
  const jitter = Math.floor(Math.random() * 500);
  return base + jitter;
}

async function streamObjectToTemp(input: {
  objectKey: string;
  maxBytes: number;
  expectedBytes: number;
}): Promise<{ localPath: string; cleanup: () => Promise<void> }> {
  const media = getMediaObjectStorage();
  const workRoot = process.env.CHELCOACH_INSPECTION_TMPDIR?.trim() || join(tmpdir(), "chelcoach-inspect");
  await fs.mkdir(workRoot, { recursive: true });

  const avail = await availableDiskBytes(workRoot);
  const need = input.expectedBytes + DISK_SAFETY_MARGIN_BYTES;
  if (avail < need) {
    throw Object.assign(new Error("INSUFFICIENT_WORKER_DISK"), { code: "INSUFFICIENT_WORKER_DISK" });
  }

  const localPath = join(
    workRoot,
    `job-${Date.now()}-${Math.random().toString(16).slice(2)}.bin`,
  );

  // Prefer adapter materialize when available (already stream-to-disk).
  const withMaterialize = media as {
    materializeForInspection?: (
      key: string,
      maxBytes?: number,
    ) => Promise<{ localPath: string; cleanup: () => Promise<void> }>;
  };
  if (typeof withMaterialize.materializeForInspection === "function") {
    return withMaterialize.materializeForInspection(input.objectKey, input.maxBytes);
  }

  const source = await media.openReadStream(input.objectKey);
  let written = 0;
  const limiter = new PassThrough();
  limiter.on("data", (chunk: Buffer) => {
    written += chunk.length;
    if (written > input.maxBytes) {
      limiter.destroy(
        Object.assign(new Error("VIDEO_FILE_TOO_LARGE"), { code: "VIDEO_FILE_TOO_LARGE" }),
      );
    }
  });
  await pipeline(source as Readable, limiter, createWriteStream(localPath));
  return {
    localPath,
    cleanup: async () => {
      await fs.rm(localPath, { force: true });
    },
  };
}

export function buildPublicInspectionSummary(
  job: MediaInspectionJobRecord | undefined,
): PublicInspectionSummary | undefined {
  if (!job) return undefined;
  const poll = pollAfterMsForInspection(job.status);
  return {
    status: job.status,
    message:
      job.status === "failed" && job.errorMessage
        ? job.errorMessage
        : publicInspectionMessage(job.status),
    retryable: job.retryable && job.status !== "completed",
    ...(poll ? { pollAfterMs: poll } : {}),
  };
}

export function createMediaInspectionWorker(opts?: {
  leaseMs?: number;
}): MediaInspectionWorker {
  const leaseMs = opts?.leaseMs ?? DEFAULT_LEASE_MS;
  const jobs = () => getInspectionJobRepository();

  return {
    async claimNext(input) {
      return jobs().claimNext({
        workerId: input.workerId,
        now: input.now,
        leaseMs,
      });
    },

    async heartbeat(input) {
      const job = await jobs().get(input.jobId);
      if (!job || job.workerId !== input.workerId) return;
      const now = new Date();
      await jobs().update(input.jobId, {
        heartbeatAt: now.toISOString(),
        claimExpiresAt: new Date(now.getTime() + (input.leaseMs ?? leaseMs)).toISOString(),
      });
    },

    async process(input) {
      const repo = jobs();
      let job = await repo.get(input.jobId);
      if (!job) {
        return {
          ok: false,
          jobId: input.jobId,
          uploadId: "",
          status: "failed",
          errorCode: "UPLOAD_NOT_FOUND",
        };
      }
      if (job.workerId && job.workerId !== input.workerId && job.status !== "queued") {
        // Not our claim
        return {
          ok: false,
          jobId: job.id,
          uploadId: job.uploadId,
          status: job.status,
          errorCode: "WORKER_UNAVAILABLE",
        };
      }

      const uploads = getUploadRepository();
      const upload = await uploads.get(job.uploadId);
      if (!upload) {
        await repo.update(job.id, {
          status: "expired",
          errorCode: "UPLOAD_NOT_FOUND",
          errorMessage: "Upload missing.",
          retryable: false,
          failedAt: new Date().toISOString(),
        });
        return {
          ok: false,
          jobId: job.id,
          uploadId: job.uploadId,
          status: "expired",
          errorCode: "UPLOAD_NOT_FOUND",
        };
      }

      // Absolute retention: do not inspect beyond absolute delete.
      if (new Date(upload.absoluteDeleteAt).getTime() <= Date.now()) {
        await repo.update(job.id, {
          status: "expired",
          errorCode: "UPLOAD_EXPIRED",
          errorMessage: "Upload expired before inspection completed.",
          retryable: false,
          failedAt: new Date().toISOString(),
        });
        return {
          ok: false,
          jobId: job.id,
          uploadId: job.uploadId,
          status: "expired",
          errorCode: "UPLOAD_EXPIRED",
        };
      }

      let cleanup: (() => Promise<void>) | null = null;
      try {
        await repo.update(job.id, { status: "downloading" });
        logEvent("download_started", { jobId: job.id, uploadId: job.uploadId });

        const media = getMediaObjectStorage();
        const before = await media.statObject(job.objectKey);
        if (!before.exists) {
          throw Object.assign(new Error("STORAGE_OBJECT_NOT_FOUND"), {
            code: "STORAGE_OBJECT_NOT_FOUND",
          });
        }
        if (
          before.fingerprint &&
          job.objectFingerprint &&
          before.fingerprint !== job.objectFingerprint
        ) {
          throw Object.assign(new Error("STORAGE_OBJECT_MISMATCH"), {
            code: "STORAGE_OBJECT_MISMATCH",
          });
        }

        const maxBytes = getMaxUploadBytes();
        const expected = before.byteSize || job.trustedByteSize || 0;
        const materialized = await streamObjectToTemp({
          objectKey: job.objectKey,
          maxBytes,
          expectedBytes: expected,
        });
        cleanup = materialized.cleanup;

        await this.heartbeat({ workerId: input.workerId, jobId: job.id });
        await repo.update(job.id, { status: "inspecting" });
        logEvent("inspection_started", { jobId: job.id, uploadId: job.uploadId });

        const parsed = (await runFfprobeJson(materialized.localPath)) as {
          streams?: Array<{
            codec_type?: string;
            codec_name?: string;
            width?: number;
            height?: number;
            avg_frame_rate?: string;
          }>;
          format?: { duration?: string; size?: string; format_name?: string };
        };

        await repo.update(job.id, { status: "validating" });

        const after = await media.statObject(job.objectKey);
        if (!after.exists) {
          throw Object.assign(new Error("STORAGE_OBJECT_MISMATCH"), {
            code: "STORAGE_OBJECT_MISMATCH",
          });
        }
        if (
          after.fingerprint &&
          job.objectFingerprint &&
          after.fingerprint !== job.objectFingerprint
        ) {
          throw Object.assign(new Error("STORAGE_OBJECT_MISMATCH"), {
            code: "STORAGE_OBJECT_MISMATCH",
          });
        }

        const video = parsed.streams?.find((s) => s.codec_type === "video");
        const audio = parsed.streams?.find((s) => s.codec_type === "audio");
        if (!video) {
          throw Object.assign(new Error("NO_VIDEO_STREAM"), { code: "NO_VIDEO_STREAM" });
        }
        const durationSeconds = Number(parsed.format?.duration);
        if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
          throw Object.assign(new Error("MEDIA_INSPECTION_FAILED"), {
            code: "MEDIA_INSPECTION_FAILED",
          });
        }
        const durationCheck = assertDurationAllowed(durationSeconds);
        if (!durationCheck.ok) {
          throw Object.assign(new Error("VIDEO_DURATION_EXCEEDED"), {
            code: "VIDEO_DURATION_EXCEEDED",
          });
        }
        const byteSize = Number(parsed.format?.size) || after.byteSize || expected;
        if (byteSize > maxBytes) {
          throw Object.assign(new Error("VIDEO_FILE_TOO_LARGE"), { code: "VIDEO_FILE_TOO_LARGE" });
        }

        let classification: MediaClassification;
        try {
          classification = classifyMediaDuration(durationSeconds);
        } catch {
          throw Object.assign(new Error("VIDEO_DURATION_EXCEEDED"), {
            code: "VIDEO_DURATION_EXCEEDED",
          });
        }

        const now = new Date();
        const policy = getMediaRetentionPolicy();
        const trustedMedia = {
          durationSec: Math.min(durationSeconds, SCOTTY_MAX_DURATION_SEC),
          width: video.width ?? 1,
          height: video.height ?? 1,
          fps: parseFps(video.avg_frame_rate),
          codec: video.codec_name,
          container: upload.mimeType === "video/quicktime" ? "mov" : "mp4",
          inspectedAt: now.toISOString(),
        };

        // Finalize job + upload transactionally where practical (memory/drizzle sequential).
        await repo.update(job.id, {
          status: "completed",
          trustedByteSize: byteSize,
          trustedMimeType: upload.mimeType,
          trustedDurationSec: trustedMedia.durationSec,
          videoCodec: video.codec_name,
          audioCodec: audio?.codec_name,
          width: video.width,
          height: video.height,
          frameRate: trustedMedia.fps,
          mediaClassification: classification,
          completedAt: now.toISOString(),
          claimExpiresAt: undefined,
          retryable: false,
          errorCode: undefined,
          errorMessage: undefined,
        });

        const current = await uploads.get(job.uploadId);
        if (current && current.uploadStatus === "processing") {
          assertUploadTransition("processing", "ready");
          await uploads.update(job.uploadId, {
            uploadStatus: "ready",
            storedByteSize: byteSize,
            trustedMedia,
            mediaClassification: classification,
            context: {
              ...current.context,
              mediaClassification: classification,
            },
            expiresAt: calculateExpiresAt(now, policy).toISOString(),
            absoluteDeleteAt: calculateAbsoluteDeleteAt(now, policy).toISOString(),
            readyAt: now.toISOString(),
            errorCode: undefined,
            errorMessage: undefined,
          });
        }

        logEvent("inspection_completed", {
          jobId: job.id,
          uploadId: job.uploadId,
          duration: Math.round(durationSeconds),
          byteSize,
          mediaClassification: classification,
          retentionPolicyVersion: RETENTION_POLICY_VERSION,
        });

        return {
          ok: true,
          jobId: job.id,
          uploadId: job.uploadId,
          status: "completed",
        };
      } catch (err) {
        const code = String((err as { code?: string }).code || "MEDIA_INSPECTION_FAILED");
        const permanent = PERMANENT_ERRORS.has(code);
        job = (await repo.get(job.id))!;
        const attempts = job.attemptCount;
        const canRetry = !permanent && attempts < job.maxAttempts && code !== "UPLOAD_EXPIRED";

        if (canRetry) {
          const next = new Date(Date.now() + backoffMs(attempts)).toISOString();
          await repo.update(job.id, {
            status: "queued",
            workerId: undefined,
            claimExpiresAt: undefined,
            nextAttemptAt: next,
            retryable: true,
            errorCode: code as ScottyErrorCode,
            errorMessage: "Verification temporarily failed. Retrying.",
          });
          logEvent("inspection_retry_scheduled", {
            jobId: job.id,
            uploadId: job.uploadId,
            errorCode: code,
            attempt: attempts,
          });
          return {
            ok: false,
            jobId: job.id,
            uploadId: job.uploadId,
            status: "queued",
            errorCode: code,
          };
        }

        const safeMessage =
          code === "VIDEO_DURATION_EXCEEDED"
            ? "Video exceeds the 30-minute maximum."
            : code === "NO_VIDEO_STREAM"
              ? "This file does not contain a usable video stream."
              : code === "VIDEO_FILE_TOO_LARGE"
                ? "Video file exceeds the maximum upload size."
                : code === "STORAGE_OBJECT_MISMATCH"
                  ? "Stored media does not match the authorized upload."
                  : code === "INSUFFICIENT_WORKER_DISK"
                    ? "The verification worker is temporarily out of disk space. Try again shortly."
                    : "We couldn't verify this video.";

        await repo.update(job.id, {
          status: "failed",
          failedAt: new Date().toISOString(),
          retryable: false,
          errorCode: code as ScottyErrorCode,
          errorMessage: safeMessage,
          claimExpiresAt: undefined,
        });

        // Keep upload out of ready; mark expired for permanent media failures.
        if (
          code === "VIDEO_DURATION_EXCEEDED" ||
          code === "NO_VIDEO_STREAM" ||
          code === "VIDEO_FILE_TOO_LARGE" ||
          code === "UNSUPPORTED_MEDIA_TYPE" ||
          code === "STORAGE_OBJECT_MISMATCH"
        ) {
          const media = getMediaObjectStorage();
          await media.deleteObject(job.objectKey).catch(() => undefined);
          await uploads.update(job.uploadId, {
            uploadStatus: "expired",
            errorCode: code as ScottyErrorCode,
            errorMessage: safeMessage,
            deletedAt: new Date().toISOString(),
          });
        }

        logEvent("inspection_failed", {
          jobId: job.id,
          uploadId: job.uploadId,
          errorCode: code,
        });
        return {
          ok: false,
          jobId: job.id,
          uploadId: job.uploadId,
          status: "failed",
          errorCode: code,
        };
      } finally {
        if (cleanup) await cleanup().catch(() => undefined);
      }
    },

    async runBatch(input) {
      const results: MediaInspectionWorkerResult[] = [];
      for (let i = 0; i < input.limit; i++) {
        const claimed = await this.claimNext({
          workerId: input.workerId,
          now: new Date(),
        });
        if (!claimed) break;
        const result = await this.process({
          workerId: input.workerId,
          jobId: claimed.id,
        });
        results.push(result);
      }
      return { processed: results.length, results };
    },
  };
}

let workerSingleton: MediaInspectionWorker | null = null;

export function getMediaInspectionWorker(): MediaInspectionWorker {
  if (!workerSingleton) workerSingleton = createMediaInspectionWorker();
  return workerSingleton;
}

export function setMediaInspectionWorkerForTests(w: MediaInspectionWorker | null): void {
  workerSingleton = w;
}
