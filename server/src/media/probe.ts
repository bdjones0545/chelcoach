/**
 * ffprobe-based metadata inspection + validation against mediaConfig.
 */
import { mediaConfig } from "./config";
import { MediaProcessingError } from "./errors";
import type { ProcessRunner } from "./processRunner";
import { runProcess } from "./processRunner";
import type { VideoMetadata } from "./types";
import { resolveMediaBinaries } from "./binaries";

interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  avg_frame_rate?: string;
  r_frame_rate?: string;
  duration?: string;
  side_data_list?: Array<{ rotation?: number | string }>;
  tags?: Record<string, string>;
}

interface FfprobeFormat {
  format_name?: string;
  duration?: string;
  size?: string;
}

interface FfprobeJson {
  streams?: FfprobeStream[];
  format?: FfprobeFormat;
}

function parseFps(rate: string | undefined): number {
  if (!rate || rate === "0/0") return 0;
  const [a, b] = rate.split("/").map(Number);
  if (!b) return Number.isFinite(a) ? a : 0;
  return b === 0 ? 0 : a / b;
}

function parseRotation(stream: FfprobeStream): number {
  const side = stream.side_data_list?.find((s) => s.rotation !== undefined);
  if (side?.rotation !== undefined) {
    const n = Number(side.rotation);
    return Number.isFinite(n) ? n : 0;
  }
  const tag = stream.tags?.rotate;
  if (tag !== undefined) {
    const n = Number(tag);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

export async function probeVideo(
  sourcePath: string,
  sizeBytes: number,
  runner: ProcessRunner = runProcess,
): Promise<VideoMetadata> {
  const { ffprobe } = resolveMediaBinaries();

  const result = await runner(
    ffprobe,
    [
      "-v",
      "error",
      "-show_entries",
      "stream=codec_type,codec_name,width,height,avg_frame_rate,r_frame_rate,duration:stream_tags=rotate:stream_side_data=rotation:format=format_name,duration,size",
      "-of",
      "json",
      sourcePath,
    ],
    {
      timeoutMs: mediaConfig.processTimeoutMs,
      maxOutputBytes: mediaConfig.maxProcessOutputBytes,
    },
  );

  if (result.timedOut) {
    throw new MediaProcessingError("PROCESS_TIMEOUT", "ffprobe timed out");
  }
  if (result.code !== 0) {
    throw new MediaProcessingError("FFPROBE_FAILED", `exit ${result.code}`);
  }

  let parsed: FfprobeJson;
  try {
    parsed = JSON.parse(result.stdout) as FfprobeJson;
  } catch {
    throw new MediaProcessingError("FFPROBE_FAILED", "invalid ffprobe JSON");
  }

  const video = parsed.streams?.find((s) => s.codec_type === "video");
  if (!video) {
    throw new MediaProcessingError("NO_VIDEO_STREAM");
  }

  const width = Number(video.width) || 0;
  const height = Number(video.height) || 0;
  const durationSec = Number(video.duration ?? parsed.format?.duration) || 0;
  const fps = parseFps(video.avg_frame_rate) || parseFps(video.r_frame_rate);
  const rotationDeg = parseRotation(video);
  const container = (parsed.format?.format_name ?? "").split(",")[0] || "unknown";
  const codec = video.codec_name ?? "unknown";
  const formatSize = Number(parsed.format?.size) || sizeBytes;

  const meta: VideoMetadata = {
    durationSec,
    width,
    height,
    fps,
    codec,
    container,
    rotationDeg,
    hasVideoStream: true,
    sizeBytes: formatSize,
  };

  validateMetadata(meta);
  return meta;
}

export function validateMetadata(meta: VideoMetadata): void {
  if (!meta.hasVideoStream) throw new MediaProcessingError("NO_VIDEO_STREAM");
  if (!(meta.durationSec > 0) || !Number.isFinite(meta.durationSec)) {
    throw new MediaProcessingError("INVALID_VIDEO_METADATA", "missing duration");
  }
  if (!(meta.width > 0) || !(meta.height > 0)) {
    throw new MediaProcessingError("INVALID_VIDEO_METADATA", "invalid dimensions");
  }
  if (meta.width * meta.height > mediaConfig.maxPixels) {
    throw new MediaProcessingError("VIDEO_TOO_LARGE", `${meta.width}x${meta.height}`);
  }
  if (meta.durationSec > mediaConfig.maxDurationSec) {
    throw new MediaProcessingError("VIDEO_TOO_LONG", `${meta.durationSec}s`);
  }
}
