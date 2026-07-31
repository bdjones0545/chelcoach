/**
 * Derived confirmation-frame bytes — never in Postgres.
 * local_disk: CHELCOACH_MEDIA_DIR / tmp
 * supabase_storage: private chelcoach-derived-media bucket (service role)
 */
import { createReadStream, createWriteStream, promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { getChelCoachConfig } from "../config/chelcoachConfig";
import { getConfirmationFrameMaxBytes } from "../retention/policy";
import { derivedFrameObjectKey } from "../storage/supabaseStorageConfig";
import { createSupabaseMediaObjectStorage } from "../storage/supabaseMediaObjectStorage";

function rootDir(): string {
  return process.env.CHELCOACH_MEDIA_DIR?.trim() || join(tmpdir(), "chelcoach-media");
}

function isSupabaseDerivedMode(): boolean {
  return getChelCoachConfig().storage.mode === "supabase_storage";
}

/** Server-generated frame object key (mode-aware). */
export function frameObjectKey(ownerId: string, uploadId: string, frameId: string): string {
  if (isSupabaseDerivedMode()) {
    return derivedFrameObjectKey(ownerId, uploadId, frameId);
  }
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
  if (isSupabaseDerivedMode()) {
    const storage = createSupabaseMediaObjectStorage();
    await storage.writeDerivedBytes(objectKey, bytes, "image/jpeg");
    return;
  }
  const path = pathFor(objectKey);
  await fs.mkdir(dirname(path), { recursive: true });
  await pipeline(Readable.from(bytes), createWriteStream(path));
}

export async function openFrameReadStream(objectKey: string): Promise<NodeJS.ReadableStream> {
  if (isSupabaseDerivedMode()) {
    const storage = createSupabaseMediaObjectStorage();
    return storage.openReadStream(objectKey);
  }
  return createReadStream(pathFor(objectKey));
}

/**
 * Optional short-lived signed URL for private derived frames.
 * Never persist the URL; callers must not log it.
 */
export async function createFrameSignedReadUrl(
  objectKey: string,
  expiresInSeconds = 120,
): Promise<string | null> {
  if (!isSupabaseDerivedMode()) return null;
  const storage = createSupabaseMediaObjectStorage();
  return storage.createShortLivedReadUrl({ objectKey, expiresInSeconds });
}

export async function deleteFrameObject(objectKey: string): Promise<void> {
  if (isSupabaseDerivedMode()) {
    const storage = createSupabaseMediaObjectStorage();
    await storage.deleteObject(objectKey);
    return;
  }
  await fs.rm(pathFor(objectKey), { force: true });
}

export async function frameExists(objectKey: string): Promise<boolean> {
  if (isSupabaseDerivedMode()) {
    const storage = createSupabaseMediaObjectStorage();
    return storage.exists(objectKey);
  }
  try {
    await fs.access(pathFor(objectKey));
    return true;
  } catch {
    return false;
  }
}

export async function statFrame(objectKey: string): Promise<{ byteSize: number } | null> {
  if (isSupabaseDerivedMode()) {
    const storage = createSupabaseMediaObjectStorage();
    const meta = await storage.statObject(objectKey);
    return meta.exists ? { byteSize: meta.byteSize } : null;
  }
  try {
    const st = await fs.stat(pathFor(objectKey));
    return { byteSize: st.size };
  } catch {
    return null;
  }
}
