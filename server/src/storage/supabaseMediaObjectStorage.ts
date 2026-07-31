/**
 * Supabase Storage adapter for ChelCoach media (Step 10.1C).
 *
 * Browser uploads go directly via TUS + user JWT (RLS).
 * This adapter uses the service-role client only for server-authoritative
 * stat / read / delete / short-lived signed URLs / derived writes.
 *
 * Never log signed URLs or service-role credentials.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { createWriteStream, promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable, PassThrough, type Readable as NodeReadable } from "node:stream";
import type {
  MediaObjectStorage,
  StoredObjectMetadata,
  UploadWriteHandle,
} from "../mediaStorage";
import {
  derivedFrameObjectKey,
  gameplayObjectKey,
  loadSupabaseStorageConfig,
  type SupabaseStorageConfig,
} from "./supabaseStorageConfig";

function hashKey(objectKey: string): string {
  // Short non-reversible log token — not a security boundary.
  let h = 0;
  for (let i = 0; i < objectKey.length; i++) h = (h * 31 + objectKey.charCodeAt(i)) >>> 0;
  return `ok_${h.toString(16)}`;
}

export class SupabaseMediaObjectStorage implements MediaObjectStorage {
  readonly backend = "supabase";
  private client: SupabaseClient;
  private config: SupabaseStorageConfig;

  constructor(config: SupabaseStorageConfig = loadSupabaseStorageConfig()) {
    if (!config.enabled && !config.serviceRoleKey) {
      // Allow explicit construction in tests with enabled forced.
    }
    this.config = config;
    this.client = createClient(config.url, config.serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }

  createObjectKey(ownerId: string, uploadId: string): string {
    return gameplayObjectKey(ownerId, uploadId);
  }

  createDerivedObjectKey(ownerId: string, uploadId: string, frameId: string): string {
    return derivedFrameObjectKey(ownerId, uploadId, frameId);
  }

  private bucketForKey(objectKey: string): string {
    // Derived confirmation frames live in the derived bucket.
    if (objectKey.includes("/confirmation/")) return this.config.derivedBucket;
    // Legacy disk-shaped frame keys also map to derived bucket when using supabase.
    if (objectKey.includes("/frames/")) return this.config.derivedBucket;
    return this.config.gameplayBucket;
  }

  async openWriteStream(_input: {
    objectKey: string;
    contentType: string;
    maxBytes: number;
  }): Promise<UploadWriteHandle> {
    // Production ingress is browser→Supabase TUS. Server write streams are not used
    // for gameplay video in supabase_storage mode.
    throw Object.assign(new Error("STORAGE_UPLOAD_FAILED"), {
      code: "STORAGE_UPLOAD_FAILED",
      message: "Direct server write is disabled in supabase_storage mode. Use resumable browser upload.",
    });
  }

  async statObject(objectKey: string): Promise<StoredObjectMetadata> {
    const bucket = this.bucketForKey(objectKey);
    // Prefer storage.objects via service role for accurate size/MIME (list search is fuzzy).
    const { data: rows, error: queryError } = await this.client
      .schema("storage")
      .from("objects")
      .select("name, metadata")
      .eq("bucket_id", bucket)
      .eq("name", objectKey)
      .limit(1);
    if (!queryError && rows && rows.length > 0) {
      const row = rows[0] as {
        name: string;
        metadata?: { size?: number; mimetype?: string } | null;
      };
      const meta = row.metadata ?? null;
      return {
        objectKey,
        byteSize: Number(meta?.size ?? 0) || 0,
        contentType: String(meta?.mimetype ?? "application/octet-stream"),
        exists: true,
      };
    }

    // Fallback: list parent prefix.
    const parent = objectKey.includes("/") ? objectKey.slice(0, objectKey.lastIndexOf("/")) : "";
    const name = objectKey.includes("/") ? objectKey.slice(objectKey.lastIndexOf("/") + 1) : objectKey;
    const { data, error } = await this.client.storage.from(bucket).list(parent, {
      search: name,
      limit: 20,
    });
    if (error) {
      console.error(
        `[chelcoach-storage] event=stat_failed bucket=${bucket} keyHash=${hashKey(objectKey)}`,
      );
      return { objectKey, byteSize: 0, contentType: "application/octet-stream", exists: false };
    }
    const row = (data ?? []).find((r) => r.name === name);
    if (!row) {
      return { objectKey, byteSize: 0, contentType: "application/octet-stream", exists: false };
    }
    const meta = row.metadata as { size?: number; mimetype?: string } | null;
    return {
      objectKey,
      byteSize: Number(meta?.size ?? 0) || 0,
      contentType: String(meta?.mimetype ?? "application/octet-stream"),
      exists: true,
    };
  }

  async exists(objectKey: string): Promise<boolean> {
    return (await this.statObject(objectKey)).exists;
  }

  async openReadStream(objectKey: string): Promise<NodeReadable> {
    const bucket = this.bucketForKey(objectKey);
    const { data, error } = await this.client.storage.from(bucket).download(objectKey);
    if (error || !data) {
      throw Object.assign(new Error("STORAGE_OBJECT_NOT_FOUND"), {
        code: "STORAGE_OBJECT_NOT_FOUND",
      });
    }
    // Blob → Node Readable without holding an extra full copy beyond the Blob buffer
    // provided by the SDK. For inspection we prefer materializeForInspection (temp file).
    const ab = await data.arrayBuffer();
    return Readable.from(Buffer.from(ab));
  }

  /**
   * Stream object to a bounded temp file for ffprobe, then delete.
   * Avoids treating Vercel Functions as long-running FFmpeg hosts — local/dev only
   * or a dedicated worker should call this for large media.
   */
  async materializeForInspection(
    objectKey: string,
    maxBytes = 2_147_483_648,
  ): Promise<{ localPath: string; cleanup: () => Promise<void> }> {
    const bucket = this.bucketForKey(objectKey);
    const { data, error } = await this.client.storage.from(bucket).download(objectKey);
    if (error || !data) {
      throw Object.assign(new Error("STORAGE_OBJECT_NOT_FOUND"), {
        code: "STORAGE_OBJECT_NOT_FOUND",
      });
    }
    if (data.size > maxBytes) {
      throw Object.assign(new Error("VIDEO_FILE_TOO_LARGE"), { code: "VIDEO_FILE_TOO_LARGE" });
    }
    const localPath = join(
      tmpdir(),
      `chelcoach-inspect-${Date.now()}-${Math.random().toString(16).slice(2)}.bin`,
    );
    const nodeStream = Readable.fromWeb(data.stream() as import("node:stream/web").ReadableStream);
    let written = 0;
    const limiter = new PassThrough();
    limiter.on("data", (chunk: Buffer) => {
      written += chunk.length;
      if (written > maxBytes) {
        limiter.destroy(Object.assign(new Error("VIDEO_FILE_TOO_LARGE"), { code: "VIDEO_FILE_TOO_LARGE" }));
      }
    });
    await pipeline(nodeStream, limiter, createWriteStream(localPath));
    return {
      localPath,
      cleanup: async () => {
        await fs.rm(localPath, { force: true });
      },
    };
  }

  async resolveLocalPath(objectKey: string): Promise<string | null> {
    // For inspectors that call resolveLocalPath — materialize once.
    // Callers must not assume a long-lived path; prefer materializeForInspection.
    try {
      const { localPath } = await this.materializeForInspection(objectKey);
      // Intentionally leave file for immediate ffprobe; schedule unlink.
      setTimeout(() => {
        void fs.rm(localPath, { force: true });
      }, 120_000);
      return localPath;
    } catch {
      return null;
    }
  }

  async deleteObject(objectKey: string): Promise<{ deleted: boolean; alreadyAbsent: boolean }> {
    const bucket = this.bucketForKey(objectKey);
    const { error } = await this.client.storage.from(bucket).remove([objectKey]);
    if (error) {
      // Idempotent: missing object is success.
      const msg = (error.message || "").toLowerCase();
      if (msg.includes("not found") || msg.includes("404")) {
        return { deleted: false, alreadyAbsent: true };
      }
      console.error(
        `[chelcoach-storage] event=delete_failed bucket=${bucket} keyHash=${hashKey(objectKey)}`,
      );
      throw Object.assign(new Error("STORAGE_UNAVAILABLE"), { code: "STORAGE_UNAVAILABLE" });
    }
    return { deleted: true, alreadyAbsent: false };
  }

  async writeDerivedBytes(objectKey: string, bytes: Buffer, contentType: string): Promise<void> {
    const bucket = this.bucketForKey(objectKey);
    const { error } = await this.client.storage.from(bucket).upload(objectKey, bytes, {
      contentType,
      upsert: true,
    });
    if (error) {
      throw Object.assign(new Error("STORAGE_UPLOAD_FAILED"), { code: "STORAGE_UPLOAD_FAILED" });
    }
  }

  async createShortLivedReadUrl(input: {
    objectKey: string;
    expiresInSeconds: number;
  }): Promise<string> {
    const bucket = this.bucketForKey(input.objectKey);
    const ttl = Math.max(30, Math.min(input.expiresInSeconds, 3600));
    const { data, error } = await this.client.storage
      .from(bucket)
      .createSignedUrl(input.objectKey, ttl);
    if (error || !data?.signedUrl) {
      throw Object.assign(new Error("STORAGE_ACCESS_DENIED"), { code: "STORAGE_ACCESS_DENIED" });
    }
    return data.signedUrl;
  }
}

export function createSupabaseMediaObjectStorage(
  config?: SupabaseStorageConfig,
): SupabaseMediaObjectStorage {
  return new SupabaseMediaObjectStorage(config ?? loadSupabaseStorageConfig());
}
