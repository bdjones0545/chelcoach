/**
 * Centralized media / extraction limits (Phase 3).
 * Overridable via env; validated at load. Conservative MVP defaults.
 */
function intEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min || n > max) {
    throw new Error(`[chelcoach-api] Invalid ${name}=${raw} (expected ${min}–${max}).`);
  }
  return Math.floor(n);
}

function floatEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min || n > max) {
    throw new Error(`[chelcoach-api] Invalid ${name}=${raw} (expected ${min}–${max}).`);
  }
  return n;
}

/**
 * Why these defaults:
 * - maxDuration 180s — matches the backend plan's ~3 min clip cap (bounds AI cost later).
 * - maxFrames 12 — enough timeline coverage without flooding disk/tokens later.
 * - maxFrameWidth 1280 — readable stills, not 4K.
 * - processTimeout 60s — one clip on a small VM; fail rather than hang.
 * - concurrency 1 — single Reserved VM / in-process MVP.
 * - maxPixels 1920*1080 — reject absurd resolutions before FFmpeg burns CPU.
 * - jpegQuality 3 (ffmpeg -q:v scale, 2–5 typical) — small files, good enough for AI later.
 */
export const mediaConfig = {
  /** Max video duration in seconds. */
  maxDurationSec: intEnv("MEDIA_MAX_DURATION_SEC", 180, 1, 600),
  /** Max extracted frames per clip. */
  maxFrames: intEnv("MEDIA_MAX_FRAMES", 12, 1, 60),
  /** Scale frames so width ≤ this (height auto, even). */
  maxFrameWidth: intEnv("MEDIA_MAX_FRAME_WIDTH", 1280, 160, 3840),
  /** Reject videos whose width*height exceeds this. */
  maxPixels: intEnv("MEDIA_MAX_PIXELS", 1920 * 1080, 320 * 240, 3840 * 2160),
  /** Per-process timeout for ffprobe / each ffmpeg frame call. */
  processTimeoutMs: intEnv("MEDIA_PROCESS_TIMEOUT_MS", 60_000, 5_000, 300_000),
  /** Cap captured stdout+stderr per process (bytes). */
  maxProcessOutputBytes: intEnv("MEDIA_MAX_PROCESS_OUTPUT_BYTES", 64 * 1024, 4_096, 1024 * 1024),
  /** Max concurrent in-process extraction jobs. */
  maxConcurrentJobs: intEnv("MEDIA_MAX_CONCURRENT_JOBS", 1, 1, 4),
  /** Fraction of the timeline to skip at start/end when sampling. */
  edgeSkipFraction: floatEnv("MEDIA_EDGE_SKIP_FRACTION", 0.05, 0, 0.2),
  /** ffmpeg -q:v for JPEG (2≈high quality, 5≈smaller). */
  jpegQuality: intEnv("MEDIA_JPEG_QUALITY", 3, 2, 8),
  /** Optional explicit binary paths (otherwise PATH lookup). */
  ffmpegPath: process.env.FFMPEG_PATH?.trim() || "",
  ffprobePath: process.env.FFPROBE_PATH?.trim() || "",
} as const;

export type MediaConfig = typeof mediaConfig;
