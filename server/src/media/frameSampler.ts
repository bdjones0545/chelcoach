/**
 * Single-frame JPEG sampling with ffmpeg, from a signed URL or a local file.
 *
 * Every sampled frame is bounded (longest edge, byte size) and the whole source video is never
 * read into memory: ffmpeg seeks to each timestamp and decodes one frame.
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveMediaBinary } from "./ffmpegBinaries";
import { resolveMediaSource, type MediaSource } from "./mediaSource";

export interface SampledFrame {
  timestampSec: number;
  mimeType: "image/jpeg";
  width: number;
  height: number;
  bytes: Buffer;
}

export interface FrameSampler {
  sample(input: {
    objectKey: string;
    timestampsSec: number[];
    maxEdge: number;
    maxBytes: number;
    /** Per-frame ffmpeg timeout. */
    timeoutMs?: number;
  }): Promise<SampledFrame[]>;
}

const DEFAULT_FRAME_TIMEOUT_MS = 45_000;

/**
 * Evenly spaced sample timestamps across a clip, keeping clear of the very start and end (title
 * cards, loading, and end-of-clip fades). Density is bounded so a 30-minute game does not become
 * hundreds of images; the sparsity is disclosed in the report.
 */
export function planSampleTimestamps(
  durationSec: number,
  opts: { minFrames?: number; maxFrames?: number; secondsPerFrame?: number } = {},
): number[] {
  const minFrames = opts.minFrames ?? 6;
  const maxFrames = opts.maxFrames ?? 24;
  const secondsPerFrame = opts.secondsPerFrame ?? 8;
  if (!Number.isFinite(durationSec) || durationSec <= 0) return [];
  const count = Math.max(1, Math.min(maxFrames, Math.max(minFrames, Math.round(durationSec / secondsPerFrame))));
  const inset = Math.min(durationSec * 0.04, 2);
  const usable = Math.max(durationSec - 2 * inset, 0);
  if (count === 1 || usable <= 0) return [Math.max(0, Math.min(durationSec / 2, durationSec - 0.1))];
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    const t = inset + (usable * i) / (count - 1);
    out.push(Math.round(Math.min(t, Math.max(0, durationSec - 0.2)) * 100) / 100);
  }
  return [...new Set(out)];
}

/** Dimensions from a JPEG's SOF marker; falls back to zeros when not found. */
export function jpegDimensions(bytes: Buffer): { width: number; height: number } {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return { width: 0, height: 0 };
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = bytes[offset + 1]!;
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    const length = bytes.readUInt16BE(offset + 2);
    const isSof =
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf);
    if (isSof) {
      return { height: bytes.readUInt16BE(offset + 5), width: bytes.readUInt16BE(offset + 7) };
    }
    offset += 2 + length;
  }
  return { width: 0, height: 0 };
}

function extractionError(detail?: string): Error & { code: string; detail?: string } {
  return Object.assign(new Error("FRAME_EXTRACTION_FAILED"), {
    code: "FRAME_EXTRACTION_FAILED",
    detail: detail?.slice(0, 300),
  });
}

export function runFfmpegFrame(input: {
  source: MediaSource;
  timestampSec: number;
  outPath: string;
  maxEdge: number;
  timeoutMs: number;
}): Promise<void> {
  const ffmpeg = resolveMediaBinary("ffmpeg");
  if (!ffmpeg) return Promise.reject(extractionError("ffmpeg unavailable"));
  const args = [
    "-hide_banner",
    "-loglevel",
    "error",
    "-nostdin",
    ...(input.source.kind === "url" ? ["-reconnect", "1", "-reconnect_streamed", "1"] : []),
    "-ss",
    String(input.timestampSec),
    "-i",
    input.source.value,
    "-frames:v",
    "1",
    "-vf",
    `scale='min(${input.maxEdge},iw)':'-2'`,
    "-q:v",
    "3",
    "-f",
    "image2",
    "-y",
    input.outPath,
  ];
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(extractionError("ffmpeg timeout"));
    }, input.timeoutMs);
    child.stderr.on("data", (d: Buffer) => {
      if (stderr.length < 4000) stderr += d.toString("utf8");
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(extractionError(err.message));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      // The signed URL may appear in ffmpeg's stderr; keep diagnostics out of anything logged.
      if (code === 0) resolve();
      else reject(extractionError(stderr.replace(/https?:\/\/\S+/g, "[url]")));
    });
  });
}

export class FfmpegFrameSampler implements FrameSampler {
  async sample(input: {
    objectKey: string;
    timestampsSec: number[];
    maxEdge: number;
    maxBytes: number;
    timeoutMs?: number;
  }): Promise<SampledFrame[]> {
    const source = await resolveMediaSource(input.objectKey);
    const out: SampledFrame[] = [];
    const tmpFiles: string[] = [];
    try {
      for (const ts of input.timestampsSec) {
        const outPath = join(tmpdir(), `chelcoach-frame-${randomUUID()}.jpg`);
        tmpFiles.push(outPath);
        await runFfmpegFrame({
          source,
          timestampSec: ts,
          outPath,
          maxEdge: input.maxEdge,
          timeoutMs: input.timeoutMs ?? DEFAULT_FRAME_TIMEOUT_MS,
        });
        const bytes = await fs.readFile(outPath);
        if (bytes.length === 0) throw extractionError("empty frame");
        if (bytes.length > input.maxBytes) throw extractionError("frame exceeds byte limit");
        const dims = jpegDimensions(bytes);
        out.push({
          timestampSec: ts,
          mimeType: "image/jpeg",
          width: dims.width || input.maxEdge,
          height: dims.height || Math.round((input.maxEdge * 9) / 16),
          bytes,
        });
      }
      return out;
    } finally {
      await Promise.all(tmpFiles.map((f) => fs.rm(f, { force: true })));
      if (source.kind === "path" && source.cleanup) await source.cleanup().catch(() => undefined);
    }
  }
}

let sampler: FrameSampler = new FfmpegFrameSampler();

export function getFrameSampler(): FrameSampler {
  return sampler;
}

export function setFrameSamplerForTests(next: FrameSampler | undefined): void {
  sampler = next ?? new FfmpegFrameSampler();
}
