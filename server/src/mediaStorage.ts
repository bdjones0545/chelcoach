/**
 * Streaming media object storage (Step 2).
 *
 * Design: request body is streamed to a disk-backed object store with byte-limit
 * enforcement and backpressure via Node streams. The full video is never held as
 * one Buffer in application memory.
 *
 * Replit Object Storage client only exposes uploadFromBytes today — when
 * STORAGE_BACKEND=replit, finalize may read the disk file into a Buffer once for
 * the provider call. That limitation is logged; the HTTP ingress path remains streamed.
 */
import { createReadStream, createWriteStream, promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import type { Readable } from "node:stream";
import { Transform } from "node:stream";
import { getStorage, type ObjectStorage } from "./storage";
import { createSupabaseMediaObjectStorage } from "./storage/supabaseMediaObjectStorage";

export interface StoredObjectMetadata {
  objectKey: string;
  byteSize: number;
  contentType: string;
  exists: boolean;
  /** Opaque fingerprint for object-version integrity (etag/version/updated+size). */
  fingerprint?: string;
  etag?: string;
  updatedAt?: string;
}

export interface UploadWriteHandle {
  objectKey: string;
  /** Stream request body into this writable (backpressure-aware). */
  writeStream: NodeJS.WritableStream;
  /** Bytes accepted so far (updated by the counting transform). */
  getBytesWritten: () => number;
  /** Finalize after the request stream ends successfully. */
  finalize: () => Promise<StoredObjectMetadata>;
  /** Abort and delete partial object. */
  abort: () => Promise<void>;
}

export interface MediaObjectStorage {
  readonly backend: string;
  createObjectKey(ownerId: string, uploadId: string): string;
  openWriteStream(input: {
    objectKey: string;
    contentType: string;
    maxBytes: number;
  }): Promise<UploadWriteHandle>;
  statObject(objectKey: string): Promise<StoredObjectMetadata>;
  openReadStream(objectKey: string): Promise<Readable>;
  /** Absolute path for inspectors that need a local file (disk-backed only). */
  resolveLocalPath?(objectKey: string): Promise<string | null>;
  deleteObject(objectKey: string): Promise<{ deleted: boolean; alreadyAbsent: boolean }>;
  exists(objectKey: string): Promise<boolean>;
}

class ByteLimitTransform extends Transform {
  bytes = 0;
  constructor(
    private maxBytes: number,
    private onBytes: (n: number) => void,
  ) {
    super();
  }
  override _transform(
    chunk: Buffer,
    _enc: BufferEncoding,
    cb: (error?: Error | null, data?: Buffer) => void,
  ): void {
    this.bytes += chunk.length;
    this.onBytes(this.bytes);
    if (this.bytes > this.maxBytes) {
      cb(Object.assign(new Error("VIDEO_FILE_TOO_LARGE"), { code: "VIDEO_FILE_TOO_LARGE" }));
      return;
    }
    cb(null, chunk);
  }
}

function rootDir(): string {
  return process.env.CHELCOACH_MEDIA_DIR?.trim() || join(tmpdir(), "chelcoach-media");
}

class DiskMediaObjectStorage implements MediaObjectStorage {
  readonly backend = "disk";
  private meta = new Map<string, { byteSize: number; contentType: string; path: string }>();

  createObjectKey(ownerId: string, uploadId: string): string {
    // Pseudonymous owner segment — never email/gamertag.
    return `chelcoach/uploads/${ownerId}/${uploadId}/source`;
  }

  private pathFor(objectKey: string): string {
    const safe = objectKey.replace(/\.\./g, "").replace(/^\/+/, "");
    return join(rootDir(), safe);
  }

  async openWriteStream(input: {
    objectKey: string;
    contentType: string;
    maxBytes: number;
  }): Promise<UploadWriteHandle> {
    const filePath = this.pathFor(input.objectKey);
    await fs.mkdir(dirname(filePath), { recursive: true });
    // Remove any prior partial.
    await fs.rm(filePath, { force: true });

    let bytesWritten = 0;
    const limiter = new ByteLimitTransform(input.maxBytes, (n) => {
      bytesWritten = n;
    });
    const file = createWriteStream(filePath);
    let aborted = false;
    let finalized = false;

    // Pipe limiter → file; callers write to limiter.
    limiter.pipe(file);

    const waitForFile = new Promise<void>((resolve, reject) => {
      file.on("finish", () => resolve());
      file.on("error", reject);
      limiter.on("error", reject);
    });

    return {
      objectKey: input.objectKey,
      writeStream: limiter,
      getBytesWritten: () => bytesWritten,
      finalize: async () => {
        if (aborted) throw new Error("upload aborted");
        if (!finalized) {
          if (!limiter.writableEnded) limiter.end();
          await waitForFile;
          finalized = true;
        }
        const st = await fs.stat(filePath);
        this.meta.set(input.objectKey, {
          byteSize: st.size,
          contentType: input.contentType,
          path: filePath,
        });
        return {
          objectKey: input.objectKey,
          byteSize: st.size,
          contentType: input.contentType,
          exists: true,
        };
      },
      abort: async () => {
        aborted = true;
        limiter.destroy();
        file.destroy();
        await fs.rm(filePath, { force: true });
        this.meta.delete(input.objectKey);
      },
    };
  }

  async statObject(objectKey: string): Promise<StoredObjectMetadata> {
    const m = this.meta.get(objectKey);
    if (m) {
      return { objectKey, byteSize: m.byteSize, contentType: m.contentType, exists: true };
    }
    const path = this.pathFor(objectKey);
    try {
      const st = await fs.stat(path);
      return {
        objectKey,
        byteSize: st.size,
        contentType: "application/octet-stream",
        exists: true,
      };
    } catch {
      return { objectKey, byteSize: 0, contentType: "", exists: false };
    }
  }

  async openReadStream(objectKey: string): Promise<Readable> {
    const path = this.meta.get(objectKey)?.path ?? this.pathFor(objectKey);
    return createReadStream(path);
  }

  async resolveLocalPath(objectKey: string): Promise<string | null> {
    const path = this.meta.get(objectKey)?.path ?? this.pathFor(objectKey);
    try {
      await fs.access(path);
      return path;
    } catch {
      return null;
    }
  }

  async deleteObject(objectKey: string): Promise<{ deleted: boolean; alreadyAbsent: boolean }> {
    const path = this.meta.get(objectKey)?.path ?? this.pathFor(objectKey);
    this.meta.delete(objectKey);
    try {
      await fs.rm(path, { force: true });
      return { deleted: true, alreadyAbsent: false };
    } catch {
      return { deleted: true, alreadyAbsent: true };
    }
  }

  async exists(objectKey: string): Promise<boolean> {
    return (await this.statObject(objectKey)).exists;
  }
}

/**
 * Optional bridge: after disk finalize, copy into legacy ObjectStorage (e.g. Replit).
 * Ingress remains streamed to disk; provider sync may buffer once — documented limitation.
 */
export async function syncDiskObjectToLegacyStorage(
  media: MediaObjectStorage,
  objectKey: string,
  contentType: string,
  legacy: ObjectStorage = getStorage(),
): Promise<void> {
  if (!media.resolveLocalPath) return;
  const path = await media.resolveLocalPath(objectKey);
  if (!path) throw new Error("local object missing for sync");
  if (legacy.backend === "memory") {
    // For memory backend tests that still use put — stream via file read in chunks
    // into a single buffer only when the object is small; otherwise keep disk as SoT.
    const st = await media.statObject(objectKey);
    if (st.byteSize > 32 * 1024 * 1024) {
      console.warn(
        `[chelcoach-storage] skip memory sync for large object key=${objectKey} bytes=${st.byteSize}`,
      );
      return;
    }
    const chunks: Buffer[] = [];
    const stream = await media.openReadStream(objectKey);
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    await legacy.put(objectKey, Buffer.concat(chunks), contentType);
    return;
  }
  if (legacy.backend === "replit") {
    const { readFile } = await import("node:fs/promises");
    const data = await readFile(path);
    console.warn(
      `[chelcoach-storage] replit uploadFromBytes buffers once at finalize bytes=${data.length} (ingress was streamed)`,
    );
    await legacy.put(objectKey, data, contentType);
  }
}

let mediaInstance: MediaObjectStorage | null = null;

export function getMediaObjectStorage(): MediaObjectStorage {
  if (!mediaInstance) {
    const mode = (process.env.CHELCOACH_MEDIA_STORAGE_MODE ?? "").trim();
    mediaInstance =
      mode === "supabase_storage"
        ? createSupabaseMediaObjectStorage()
        : new DiskMediaObjectStorage();
  }
  return mediaInstance;
}

export function setMediaObjectStorageForTests(storage: MediaObjectStorage | null): void {
  mediaInstance = storage;
}

export function resetMediaObjectStorageForTests(): void {
  mediaInstance = null;
}

/** Test helper: stream a Readable into a write handle with pipeline. */
export async function pipeToUpload(
  source: Readable,
  handle: UploadWriteHandle,
): Promise<StoredObjectMetadata> {
  await pipeline(source, handle.writeStream as NodeJS.WritableStream);
  return handle.finalize();
}
