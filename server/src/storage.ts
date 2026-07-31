/**
 * Object storage abstraction (Phase 2/3).
 *
 * Two backends, selected at runtime — no paid service or secret required for CI/dev:
 *   - "memory" (default off-Replit): in-process Map. Used in local dev + CI smoke tests.
 *   - "replit": Replit Object Storage (GCS-backed). Lazy-imported so the package is only
 *     loaded when actually selected — CI never touches it.
 *
 * Phase 3 adds `get()` so extraction can read committed source bytes.
 *
 * Override with STORAGE_BACKEND=memory|replit. Defaults to "replit" when running on
 * Replit (REPL_ID present), otherwise "memory".
 */

export interface ObjectStorage {
  readonly backend: "memory" | "replit";
  put(key: string, data: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  exists(key: string): Promise<boolean>;
}

class MemoryStorage implements ObjectStorage {
  readonly backend = "memory" as const;
  private objects = new Map<string, { data: Buffer; contentType: string }>();

  async put(key: string, data: Buffer, contentType: string): Promise<void> {
    this.objects.set(key, { data, contentType });
  }

  async get(key: string): Promise<Buffer> {
    const obj = this.objects.get(key);
    if (!obj) throw new Error(`object not found: ${key}`);
    return obj.data;
  }

  async exists(key: string): Promise<boolean> {
    return this.objects.has(key);
  }
}

class ReplitStorage implements ObjectStorage {
  readonly backend = "replit" as const;
  // The Replit client is untyped here to avoid a hard type dependency; lazy-imported.
  private clientPromise: Promise<{
    uploadFromBytes: Function;
    downloadAsBytes?: Function;
    downloadToBytes?: Function;
    exists: Function;
  }> | null = null;

  private async client() {
    if (!this.clientPromise) {
      this.clientPromise = import("@replit/object-storage").then((m) => new m.Client() as never);
    }
    return this.clientPromise;
  }

  async put(key: string, data: Buffer): Promise<void> {
    const client = await this.client();
    const res = await client.uploadFromBytes(key, data);
    if (res && res.ok === false) {
      throw new Error(res.error?.message ?? "object storage upload failed");
    }
  }

  async get(key: string): Promise<Buffer> {
    const client = await this.client();
    // Support either download helper name across client versions.
    const download = client.downloadAsBytes ?? client.downloadToBytes;
    if (!download) {
      throw new Error("replit object storage client has no downloadAsBytes helper");
    }
    const res = await download.call(client, key);
    if (res && res.ok === false) {
      throw new Error(res.error?.message ?? "object storage download failed");
    }
    const value = res?.value ?? res;
    if (Buffer.isBuffer(value)) return value;
    if (value instanceof Uint8Array) return Buffer.from(value);
    throw new Error("object storage download returned unexpected type");
  }

  async exists(key: string): Promise<boolean> {
    const client = await this.client();
    const res = await client.exists(key);
    return res && res.ok ? Boolean(res.value) : false;
  }
}

let instance: ObjectStorage | null = null;

function selectBackend(): "memory" | "replit" {
  const override = process.env.STORAGE_BACKEND;
  if (override === "memory" || override === "replit") return override;
  return process.env.REPL_ID ? "replit" : "memory";
}

export function getStorage(): ObjectStorage {
  if (instance) return instance;
  instance = selectBackend() === "replit" ? new ReplitStorage() : new MemoryStorage();
  return instance;
}

/** Test helper — reset singleton between suites. */
export function resetStorageForTests(): void {
  instance = null;
}
