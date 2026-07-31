/**
 * Trusted media inspection via ffprobe (no full-file load into RAM).
 */
import { spawn } from "node:child_process";
import { getMediaObjectStorage } from "../mediaStorage";

export interface MediaInspectionResult {
  mimeType: string;
  byteSize: number;
  durationSeconds: number;
  videoCodec?: string;
  audioCodec?: string;
  width?: number;
  height?: number;
  frameRate?: number;
  hasVideoStream: boolean;
}

export interface MediaInspector {
  inspect(input: {
    uploadId: string;
    storageProvider: string;
    objectKey: string;
    declaredMimeType: string;
  }): Promise<MediaInspectionResult>;
}

function parseFps(rate: string | undefined): number | undefined {
  if (!rate || rate === "0/0") return undefined;
  const [a, b] = rate.split("/").map(Number);
  if (!b) return Number.isFinite(a) ? a : undefined;
  return b === 0 ? undefined : a / b;
}

async function runFfprobeJson(filePath: string, timeoutMs = 60_000): Promise<unknown> {
  const ffprobe = process.env.FFPROBE_PATH?.trim() || "ffprobe";
  return new Promise((resolve, reject) => {
    const child = spawn(
      ffprobe,
      [
        "-v",
        "error",
        "-show_entries",
        "stream=codec_type,codec_name,width,height,avg_frame_rate:format=format_name,duration,size",
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
      reject(new Error("ffprobe timeout"));
    }, timeoutMs);
    child.stdout.on("data", (c: Buffer) => {
      if (stdout.length < 256_000) stdout += c.toString("utf8");
    });
    child.stderr.on("data", (c: Buffer) => {
      if (stderr.length < 16_000) stderr += c.toString("utf8");
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`ffprobe failed: ${stderr || code}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch {
        reject(new Error("invalid ffprobe JSON"));
      }
    });
  });
}

export class FfprobeMediaInspector implements MediaInspector {
  async inspect(input: {
    uploadId: string;
    storageProvider: string;
    objectKey: string;
    declaredMimeType: string;
  }): Promise<MediaInspectionResult> {
    const media = getMediaObjectStorage();
    const local = media.resolveLocalPath
      ? await media.resolveLocalPath(input.objectKey)
      : null;
    if (!local) {
      throw Object.assign(new Error("MEDIA_INSPECTION_FAILED"), {
        code: "MEDIA_INSPECTION_FAILED",
      });
    }

    const stat = await media.statObject(input.objectKey);
    let parsed: {
      streams?: Array<{
        codec_type?: string;
        codec_name?: string;
        width?: number;
        height?: number;
        avg_frame_rate?: string;
      }>;
      format?: { duration?: string; size?: string; format_name?: string };
    };
    try {
      parsed = (await runFfprobeJson(local)) as typeof parsed;
    } catch (err) {
      throw Object.assign(
        new Error(err instanceof Error ? err.message : "inspection failed"),
        { code: "MEDIA_INSPECTION_FAILED" },
      );
    }

    const video = parsed.streams?.find((s) => s.codec_type === "video");
    const audio = parsed.streams?.find((s) => s.codec_type === "audio");
    if (!video) {
      throw Object.assign(new Error("no video stream"), { code: "MEDIA_INSPECTION_FAILED" });
    }
    const durationSeconds = Number(parsed.format?.duration);
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
      throw Object.assign(new Error("invalid duration"), { code: "MEDIA_INSPECTION_FAILED" });
    }
    const byteSize = Number(parsed.format?.size) || stat.byteSize;

    return {
      mimeType: input.declaredMimeType,
      byteSize,
      durationSeconds,
      videoCodec: video.codec_name,
      audioCodec: audio?.codec_name,
      width: video.width,
      height: video.height,
      frameRate: parseFps(video.avg_frame_rate),
      hasVideoStream: true,
    };
  }
}

export class FakeMediaInspector implements MediaInspector {
  constructor(
    private result:
      | MediaInspectionResult
      | ((input: {
          uploadId: string;
          storageProvider: string;
          objectKey: string;
          declaredMimeType: string;
        }) => MediaInspectionResult | Promise<MediaInspectionResult>),
  ) {}

  async inspect(input: {
    uploadId: string;
    storageProvider: string;
    objectKey: string;
    declaredMimeType: string;
  }): Promise<MediaInspectionResult> {
    return typeof this.result === "function" ? await this.result(input) : this.result;
  }
}

let inspector: MediaInspector = new FfprobeMediaInspector();

export function getMediaInspector(): MediaInspector {
  return inspector;
}

export function setMediaInspectorForTests(next: MediaInspector | undefined): void {
  inspector = next ?? new FfprobeMediaInspector();
}
