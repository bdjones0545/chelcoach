/**
 * Resolve ffmpeg / ffprobe from env overrides or PATH.
 * No machine-specific absolute paths hardcoded.
 */
import { accessSync, constants } from "node:fs";
import { delimiter } from "node:path";
import { mediaConfig } from "./config";
import { MediaProcessingError } from "./errors";

export interface MediaBinaries {
  ffmpeg: string;
  ffprobe: string;
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function which(name: string): string | null {
  const pathEnv = process.env.PATH ?? "";
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue;
    const candidate = `${dir.replace(/\/$/, "")}/${name}`;
    if (isExecutable(candidate)) return candidate;
  }
  return null;
}

let cached: MediaBinaries | null = null;

/** Resolve binaries once; throws MediaProcessingError if unavailable. */
export function resolveMediaBinaries(): MediaBinaries {
  if (cached) return cached;

  // Read env at call-time so tests can override FFMPEG_PATH / FFPROBE_PATH.
  const ffmpegOverride = process.env.FFMPEG_PATH?.trim() || mediaConfig.ffmpegPath;
  const ffprobeOverride = process.env.FFPROBE_PATH?.trim() || mediaConfig.ffprobePath;
  const ffmpeg = ffmpegOverride || which("ffmpeg");
  const ffprobe = ffprobeOverride || which("ffprobe");

  if (ffmpegOverride && !isExecutable(ffmpegOverride)) {
    throw new MediaProcessingError("FFMPEG_UNAVAILABLE", `FFMPEG_PATH not executable: ${ffmpegOverride}`);
  }
  if (ffprobeOverride && !isExecutable(ffprobeOverride)) {
    throw new MediaProcessingError("FFMPEG_UNAVAILABLE", `FFPROBE_PATH not executable: ${ffprobeOverride}`);
  }
  if (!ffmpeg || !ffprobe) {
    throw new MediaProcessingError(
      "FFMPEG_UNAVAILABLE",
      "Install ffmpeg+ffprobe and ensure they are on PATH (or set FFMPEG_PATH / FFPROBE_PATH).",
    );
  }

  cached = { ffmpeg, ffprobe };
  return cached;
}

/** Test helper — clear the cache between cases. */
export function resetMediaBinariesCache(): void {
  cached = null;
}

/** Non-throwing availability check for smoke / CI skip decisions. */
export function mediaBinariesAvailable(): boolean {
  try {
    resolveMediaBinaries();
    return true;
  } catch {
    return false;
  }
}
