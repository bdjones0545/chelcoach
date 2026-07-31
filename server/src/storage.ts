/**
 * Object storage abstraction (Phase 2+).
 *
 * Two backends, selected at runtime — no paid service or secret required for CI/dev:
 *   - "memory" (default off-Replit): in-process Map. Used in local dev + CI smoke tests.
 *   - "replit": Replit Object Storage (GCS-backed). Lazy-imported so the package is only
 *     loaded when actually selected — CI never touches it.
 *
 * Raw video binaries live here — never in Postgres.
 *
 * Override with STORAGE_BACKEND=memory|replit. Defaults to "replit" when running on
 * Replit (REPL_ID present), otherwise "memory".
 */

export interface ObjectStorage {
  readonly backend: "memory" | "replit";
  put(key: string, data: Buffer, contentType: string): Promise<void>;
  exists(key: string): Promise<boolean>;
  /**
   * Delete an object by key.
   * Idempotent: missing objects are treated as successful deletion once ownership
   * of the key has been validated by the caller.
   */
  delete(key: string): Promise<{ deleted: boolean; alreadyAbsent: boolean }>;
}

class MemoryStorage implements ObjectStorage {
  readonly backend = "memory" as const;
  private objects = new Map<string, { data: Buffer; contentType: string }>();

  async put(key: string, data: Buffer, contentType: string): Promise<void> {
    this.objects.set(key, { data, contentType });
  }

  async exists(key: string): Promise<boolean> {
    return this.objects.has(key);
  }

  async delete(key: string): Promise<{ deleted: boolean; alreadyAbsent: boolean }> {
    const had = this.objects.delete(key);
    return { deleted: true, alreadyAbsent: !had };
  }

  /** Test helper — inspect keys without exposing bytes in logs. */
  keysForTests(): string[] {
    return [...this.objects.keys()];
  }
}

class ReplitStorage implements ObjectStorage {
  readonly backend = "replit" as const;
  private clientPromise: Promise<{
    uploadFromBytes: Function;
    exists: Function;
    delete?: Function;
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

  async exists(key: string): Promise<boolean> {
    const client = await this.client();
    const res = await client.exists(key);
    return res && res.ok ? Boolean(res.value) : false;
  }

  async delete(key: string): Promise<{ deleted: boolean; alreadyAbsent: boolean }> {
    const client = await this.client();
    if (typeof client.delete !== "function") {
      // Best-effort: if delete is unavailable, treat missing object as success.
      const present = await this.exists(key);
      if (!present) return { deleted: true, alreadyAbsent: true };
      throw new Error("replit object storage client has no delete helper");
    }
    try {
      const res = await client.delete(key);
      if (res && res.ok === false) {
        const msg = String(res.error?.message ?? "delete failed");
        if (/not found|no such|404/i.test(msg)) {
          return { deleted: true, alreadyAbsent: true };
        }
        throw new Error(msg);
      }
      return { deleted: true, alreadyAbsent: false };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/not found|no such|404/i.test(msg)) {
        return { deleted: true, alreadyAbsent: true };
      }
      throw err;
    }
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

/** Test helper — install a fake storage backend. */
export function setStorageForTests(storage: ObjectStorage): void {
  instance = storage;
}
