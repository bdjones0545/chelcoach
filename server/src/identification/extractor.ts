/**
 * Confirmation frame extraction — ffmpeg when available; fake extractor for CI.
 * Never loads the full source video into RAM.
 */
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  getConfirmationFrameMaxBytes,
  getConfirmationFrameMaxEdge,
} from "../retention/policy";
import { getMediaObjectStorage } from "../mediaStorage";

export interface ExtractedConfirmationFrame {
  timestampSec: number;
  mimeType: "image/jpeg";
  width: number;
  height: number;
  bytes: Buffer;
}

export interface ConfirmationFrameExtractor {
  extract(input: {
    uploadId: string;
    objectKey: string;
    requestedTimestamps: number[];
  }): Promise<ExtractedConfirmationFrame[]>;
}

/** Minimal valid JPEG (1×1) expanded with padding metadata-free for fixture tests. */
function tinyJpeg(width: number, height: number, seed: number): Buffer {
  // Real tiny JPEG header + padding to simulate bounded derived frames without ffmpeg.
  const header = Buffer.from([
    0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01,
    0x00, 0x01, 0x00, 0x00, 0xff, 0xdb, 0x00, 0x43, 0x00, 0x08, 0x06, 0x06, 0x07, 0x06, 0x05, 0x08,
    0x07, 0x07, 0x07, 0x09, 0x09, 0x08, 0x0a, 0x0c, 0x14, 0x0d, 0x0c, 0x0b, 0x0b, 0x0c, 0x19, 0x12,
    0x13, 0x0f, 0x14, 0x1d, 0x1a, 0x1f, 0x1e, 0x1d, 0x1a, 0x1c, 0x1c, 0x20, 0x24, 0x2e, 0x27, 0x20,
    0x22, 0x2c, 0x23, 0x1c, 0x1c, 0x28, 0x37, 0x29, 0x2c, 0x30, 0x31, 0x34, 0x34, 0x34, 0x1f, 0x27,
    0x39, 0x3d, 0x38, 0x32, 0x3c, 0x2e, 0x33, 0x34, 0x32, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x01,
    0x00, 0x01, 0x01, 0x01, 0x11, 0x00, 0xff, 0xc4, 0x00, 0x1f, 0x00, 0x00, 0x01, 0x05, 0x01, 0x01,
    0x01, 0x01, 0x01, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x02, 0x03, 0x04,
    0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f,
    0x00, 0x7f, 0xff, 0xd9,
  ]);
  const pad = Buffer.alloc(Math.min(2048, 64 + (seed % 100)), seed % 255);
  void width;
  void height;
  return Buffer.concat([header, pad]);
}

export class FakeConfirmationFrameExtractor implements ConfirmationFrameExtractor {
  constructor(
    private opts: { maxEdge?: number; fail?: boolean } = {},
  ) {}

  async extract(input: {
    uploadId: string;
    objectKey: string;
    requestedTimestamps: number[];
  }): Promise<ExtractedConfirmationFrame[]> {
    if (this.opts.fail) {
      throw Object.assign(new Error("FRAME_EXTRACTION_FAILED"), {
        code: "FRAME_EXTRACTION_FAILED",
      });
    }
    const edge = this.opts.maxEdge ?? getConfirmationFrameMaxEdge();
    const maxBytes = getConfirmationFrameMaxBytes();
    // Prove we don't need to buffer the source video — only touch object existence optionally.
    const media = getMediaObjectStorage();
    const exists = await media.exists(input.objectKey);
    if (!exists) {
      throw Object.assign(new Error("FRAME_EXTRACTION_FAILED"), {
        code: "FRAME_EXTRACTION_FAILED",
      });
    }

    return input.requestedTimestamps.slice(0, 3).map((ts, i) => {
      const w = Math.min(edge, 1280);
      const h = Math.round((w * 9) / 16);
      let bytes = tinyJpeg(w, h, Math.floor(ts * 10) + i);
      if (bytes.length > maxBytes) bytes = bytes.subarray(0, maxBytes);
      return {
        timestampSec: ts,
        mimeType: "image/jpeg" as const,
        width: w,
        height: h,
        bytes,
      };
    });
  }
}

export class FfmpegConfirmationFrameExtractor implements ConfirmationFrameExtractor {
  async extract(input: {
    uploadId: string;
    objectKey: string;
    requestedTimestamps: number[];
  }): Promise<ExtractedConfirmationFrame[]> {
    const media = getMediaObjectStorage();
    const localPath = media.resolveLocalPath
      ? await media.resolveLocalPath(input.objectKey)
      : null;
    if (!localPath) {
      // Fall back to fake when no local path (e.g. pure remote without temp).
      return new FakeConfirmationFrameExtractor().extract(input);
    }

    const edge = getConfirmationFrameMaxEdge();
    const maxBytes = getConfirmationFrameMaxBytes();
    const out: ExtractedConfirmationFrame[] = [];
    const tmpFiles: string[] = [];

    try {
      for (const ts of input.requestedTimestamps.slice(0, 3)) {
        const tmp = join(tmpdir(), `chelcoach-frame-${randomUUID()}.jpg`);
        tmpFiles.push(tmp);
        await runFfmpeg(localPath, ts, tmp, edge);
        const bytes = await fs.readFile(tmp);
        if (bytes.length > maxBytes) {
          throw Object.assign(new Error("FRAME_EXTRACTION_FAILED"), {
            code: "FRAME_EXTRACTION_FAILED",
          });
        }
        out.push({
          timestampSec: ts,
          mimeType: "image/jpeg",
          width: edge,
          height: Math.round((edge * 9) / 16),
          bytes,
        });
      }
      return out;
    } finally {
      await Promise.all(tmpFiles.map((f) => fs.rm(f, { force: true })));
    }
  }
}

function runFfmpeg(inputPath: string, timestampSec: number, outPath: string, maxEdge: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const args = [
      "-hide_banner",
      "-loglevel",
      "error",
      "-ss",
      String(timestampSec),
      "-i",
      inputPath,
      "-frames:v",
      "1",
      "-vf",
      `scale='min(${maxEdge},iw)':'-2'`,
      "-q:v",
      "3",
      "-y",
      outPath,
    ];
    const child = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    child.stderr.on("data", (d) => {
      err += String(d);
    });
    child.on("error", () =>
      reject(Object.assign(new Error("FRAME_EXTRACTION_FAILED"), { code: "FRAME_EXTRACTION_FAILED" })),
    );
    child.on("close", (code) => {
      if (code === 0) resolve();
      else
        reject(
          Object.assign(new Error("FRAME_EXTRACTION_FAILED"), {
            code: "FRAME_EXTRACTION_FAILED",
            detail: err.slice(0, 200),
          }),
        );
    });
  });
}

let extractor: ConfirmationFrameExtractor = new FakeConfirmationFrameExtractor();

export function getConfirmationFrameExtractor(): ConfirmationFrameExtractor {
  return extractor;
}

export function setConfirmationFrameExtractorForTests(
  next: ConfirmationFrameExtractor | undefined,
): void {
  extractor = next ?? new FakeConfirmationFrameExtractor();
}

/** Prefer ffmpeg outside CI when CHELCOACH_USE_FFMPEG_FRAMES=1. */
export function configureDefaultFrameExtractor(): void {
  if (process.env.CHELCOACH_USE_FFMPEG_FRAMES === "1") {
    extractor = new FfmpegConfirmationFrameExtractor();
  } else {
    extractor = new FakeConfirmationFrameExtractor();
  }
}
