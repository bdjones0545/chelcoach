/**
 * Resolve a stored media object into something ffmpeg/ffprobe can read.
 *
 * Supabase Storage objects are read through a short-lived signed URL — ffmpeg and ffprobe speak
 * HTTPS and issue range requests, so probing and frame sampling never download the whole video
 * into the API process (which on Vercel has a small, ephemeral /tmp). Disk-backed storage yields
 * a local path. Anything else is materialized to a bounded temp file as a last resort.
 *
 * Signed URLs are transient by design: never persist or log them.
 */
import { createWriteStream, promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { PassThrough, type Readable } from "node:stream";
import { getMediaObjectStorage, type MediaObjectStorage } from "../mediaStorage";

export type MediaSource =
  | { kind: "url"; value: string; cleanup?: undefined }
  | { kind: "path"; value: string; cleanup?: () => Promise<void> };

type SignedUrlCapable = MediaObjectStorage & {
  createShortLivedReadUrl?: (input: {
    objectKey: string;
    expiresInSeconds: number;
  }) => Promise<string>;
};

export const DEFAULT_MEDIA_SOURCE_TTL_SECONDS = 900;

/** True when the configured storage can hand out a readable URL (no download needed). */
export function storageSupportsRemoteRead(media: MediaObjectStorage = getMediaObjectStorage()): boolean {
  return typeof (media as SignedUrlCapable).createShortLivedReadUrl === "function";
}

export async function resolveMediaSource(
  objectKey: string,
  opts: { ttlSeconds?: number; maxBytes?: number; media?: MediaObjectStorage } = {},
): Promise<MediaSource> {
  const media = (opts.media ?? getMediaObjectStorage()) as SignedUrlCapable;

  if (typeof media.createShortLivedReadUrl === "function") {
    const url = await media.createShortLivedReadUrl({
      objectKey,
      expiresInSeconds: opts.ttlSeconds ?? DEFAULT_MEDIA_SOURCE_TTL_SECONDS,
    });
    return { kind: "url", value: url };
  }

  if (typeof media.resolveLocalPath === "function") {
    const path = await media.resolveLocalPath(objectKey);
    if (path) return { kind: "path", value: path };
  }

  // Last resort: bounded materialization for adapters with neither capability (memory backend).
  const maxBytes = opts.maxBytes ?? 512 * 1024 * 1024;
  const localPath = join(tmpdir(), `chelcoach-media-${Date.now()}-${Math.random().toString(16).slice(2)}.bin`);
  const source = (await media.openReadStream(objectKey)) as Readable;
  let written = 0;
  const limiter = new PassThrough();
  limiter.on("data", (chunk: Buffer) => {
    written += chunk.length;
    if (written > maxBytes) {
      limiter.destroy(Object.assign(new Error("VIDEO_FILE_TOO_LARGE"), { code: "VIDEO_FILE_TOO_LARGE" }));
    }
  });
  await pipeline(source, limiter, createWriteStream(localPath));
  return {
    kind: "path",
    value: localPath,
    cleanup: async () => {
      await fs.rm(localPath, { force: true });
    },
  };
}

/** Log-safe description of a source — never the URL itself. */
export function describeMediaSource(source: MediaSource): string {
  return source.kind === "url" ? "signed_url" : "local_path";
}
