/**
 * Bounded JPEG frame extraction at sampled timestamps.
 * Policy: any required frame failure fails the whole job (strict).
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { resolveMediaBinaries } from "./binaries";
import { mediaConfig } from "./config";
import { MediaProcessingError } from "./errors";
import type { ProcessRunner } from "./processRunner";
import { runProcess } from "./processRunner";
import type { ExtractedFrame, VideoMetadata } from "./types";

export interface ExtractFramesOptions {
  sourcePath: string;
  framesDir: string;
  timestampsSec: number[];
  metadata: VideoMetadata;
  runner?: ProcessRunner;
}

function displaySize(meta: VideoMetadata, maxWidth: number): { width: number; height: number } {
  const rotated = Math.abs(meta.rotationDeg) === 90 || Math.abs(meta.rotationDeg) === 270;
  const srcW = rotated ? meta.height : meta.width;
  const srcH = rotated ? meta.width : meta.height;
  if (srcW <= maxWidth) return { width: srcW, height: srcH };
  const height = Math.max(2, Math.round((srcH / srcW) * maxWidth / 2) * 2);
  return { width: maxWidth, height };
}

/**
 * Extract one JPEG per timestamp into framesDir as frame-000.jpg …
 * Applies transpose for 90/270 rotation when ffprobe reported it.
 */
export async function extractFrames(options: ExtractFramesOptions): Promise<ExtractedFrame[]> {
  const runner = options.runner ?? runProcess;
  const { ffmpeg } = resolveMediaBinaries();
  await mkdir(options.framesDir, { recursive: true });

  const size = displaySize(options.metadata, mediaConfig.maxFrameWidth);
  const frames: ExtractedFrame[] = [];

  for (let i = 0; i < options.timestampsSec.length; i += 1) {
    const ts = options.timestampsSec[i];
    const filename = `frame-${String(i).padStart(3, "0")}.jpg`;
    const outPath = join(options.framesDir, filename);

    const vf: string[] = [];
    // Handle common rotations explicitly; ffmpeg autorotate via metadata is inconsistent.
    if (options.metadata.rotationDeg === 90) vf.push("transpose=1");
    else if (options.metadata.rotationDeg === 270) vf.push("transpose=2");
    else if (options.metadata.rotationDeg === 180) vf.push("transpose=1,transpose=1");
    vf.push(`scale=${size.width}:-2`);

    const args = [
      "-hide_banner",
      "-loglevel",
      "error",
      "-ss",
      String(ts),
      "-i",
      options.sourcePath,
      "-frames:v",
      "1",
      "-vf",
      vf.join(","),
      "-q:v",
      String(mediaConfig.jpegQuality),
      "-y",
      outPath,
    ];

    const result = await runner(ffmpeg, args, {
      timeoutMs: mediaConfig.processTimeoutMs,
      maxOutputBytes: mediaConfig.maxProcessOutputBytes,
    });

    if (result.timedOut) {
      throw new MediaProcessingError("PROCESS_TIMEOUT", `frame ${i} @ ${ts}s`);
    }
    if (result.code !== 0) {
      throw new MediaProcessingError("FRAME_EXTRACTION_FAILED", `frame ${i} exit ${result.code}`);
    }

    frames.push({
      index: i,
      timestampSec: ts,
      path: outPath,
      width: size.width,
      height: size.height,
    });
  }

  if (frames.length === 0) {
    throw new MediaProcessingError("FRAME_EXTRACTION_FAILED", "no frames produced");
  }

  return frames;
}
