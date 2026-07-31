/**
 * Derived confirmation-frame bytes on disk — never in Postgres.
 * Bounded size; inherits source upload expiration.
 */
import { createReadStream, createWriteStream, promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { getConfirmationFrameMaxBytes } from "../retention/policy";

function rootDir(): string {
  return process.env.CHELCOACH_MEDIA_DIR?.trim() || join(tmpdir(), "chelcoach-media");
}

export function frameObjectKey(ownerId: string, uploadId: string, frameId: string): string {
  return `chelcoach/uploads/${ownerId}/${uploadId}/frames/${frameId}.jpg`;
}

function pathFor(objectKey: string): string {
  const safe = objectKey.replace(/\.\./g, "").replace(/^\/+/, "");
  return join(rootDir(), safe);
}

export async function writeFrameBytes(
  objectKey: string,
  bytes: Buffer,
  maxBytes = getConfirmationFrameMaxBytes(),
): Promise<void> {
  if (bytes.length > maxBytes) {
    throw Object.assign(new Error("FRAME_EXTRACTION_FAILED"), {
      code: "FRAME_EXTRACTION_FAILED",
      message: "Frame exceeds maximum byte size.",
    });
  }
  const path = pathFor(objectKey);
  await fs.mkdir(dirname(path), { recursive: true });
  await pipeline(Readable.from(bytes), createWriteStream(path));
}

export async function openFrameReadStream(objectKey: string): Promise<NodeJS.ReadableStream> {
  return createReadStream(pathFor(objectKey));
}

export async function deleteFrameObject(objectKey: string): Promise<void> {
  await fs.rm(pathFor(objectKey), { force: true });
}

export async function frameExists(objectKey: string): Promise<boolean> {
  try {
    await fs.access(pathFor(objectKey));
    return true;
  } catch {
    return false;
  }
}

export async function statFrame(objectKey: string): Promise<{ byteSize: number } | null> {
  try {
    const st = await fs.stat(pathFor(objectKey));
    return { byteSize: st.size };
  } catch {
    return null;
  }
}
