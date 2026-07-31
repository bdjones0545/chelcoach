/**
 * Unit tests for Supabase Storage config + adapter boundaries (no live project required).
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  gameplayObjectKey,
  derivedFrameObjectKey,
  loadSupabaseStorageConfig,
  resumableUploadEndpoint,
} from "./supabaseStorageConfig";
import {
  loadChelCoachConfig,
  resetChelCoachConfigCacheForTests,
  validateChelCoachConfig,
} from "../config/chelcoachConfig";
import { computeReadiness } from "../config/readiness";
import { createSupabaseMediaObjectStorage } from "./supabaseMediaObjectStorage";

describe("supabase storage config", () => {
  const prev = { ...process.env };

  beforeEach(() => {
    resetChelCoachConfigCacheForTests();
  });

  afterEach(() => {
    for (const k of Object.keys(process.env)) {
      if (!(k in prev)) delete process.env[k];
    }
    Object.assign(process.env, prev);
    resetChelCoachConfigCacheForTests();
  });

  it("selects supabase_storage mode", () => {
    process.env.CHELCOACH_MEDIA_STORAGE_MODE = "supabase_storage";
    process.env.SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_ANON_KEY = "anon-test-key";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-test-key";
    process.env.SUPABASE_GAMEPLAY_BUCKET = "chelcoach-gameplay";
    process.env.SUPABASE_DERIVED_MEDIA_BUCKET = "chelcoach-derived-media";
    const cfg = loadChelCoachConfig();
    assert.equal(cfg.storage.mode, "supabase_storage");
    assert.equal(cfg.storage.supabaseStorageConfigured, true);
  });

  it("keeps local_disk as default / development mode", () => {
    delete process.env.CHELCOACH_MEDIA_STORAGE_MODE;
    delete process.env.STORAGE_BACKEND;
    const cfg = loadChelCoachConfig();
    assert.equal(cfg.storage.mode, "local_disk");
  });

  it("blocks production ready flag without supabase_storage", () => {
    process.env.NODE_ENV = "production";
    process.env.CHELCOACH_MEDIA_STORAGE_MODE = "local_disk";
    process.env.CHELCOACH_PRODUCTION_MEDIA_STORAGE_READY = "true";
    process.env.DATABASE_URL = "postgres://u:p@localhost:5432/db";
    process.env.CHELCOACH_AUTH_MODE = "supabase_auth";
    process.env.SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_ANON_KEY = "anon";
    process.env.CHELCOACH_PRODUCTION_AUTH_READY = "true";
    process.env.CHELCOACH_LEGACY_UPLOAD_ENABLED = "false";
    process.env.CORS_ORIGIN = "https://app.example";
    const cfg = loadChelCoachConfig();
    const v = validateChelCoachConfig(cfg);
    assert.ok(v.issues.some((i) => i.code === "MEDIA_STORAGE_READY_WITHOUT_SUPABASE"));
  });

  it("rejects missing bucket / service-role when supabase_storage enabled", () => {
    process.env.CHELCOACH_MEDIA_STORAGE_MODE = "supabase_storage";
    process.env.SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_ANON_KEY = "anon";
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    assert.throws(() => loadSupabaseStorageConfig(), /STORAGE_NOT_CONFIGURED|SERVICE_ROLE/);
  });

  it("readiness stays false until production media ready flag", () => {
    process.env.NODE_ENV = "production";
    process.env.CHELCOACH_MEDIA_STORAGE_MODE = "supabase_storage";
    process.env.CHELCOACH_PRODUCTION_MEDIA_STORAGE_READY = "false";
    process.env.SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_ANON_KEY = "anon-key";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-key";
    process.env.DATABASE_URL = "postgres://u:p@localhost:5432/db";
    process.env.CHELCOACH_AUTH_MODE = "supabase_auth";
    process.env.CHELCOACH_PRODUCTION_AUTH_READY = "true";
    process.env.CHELCOACH_LEGACY_UPLOAD_ENABLED = "false";
    process.env.CORS_ORIGIN = "https://app.example";
    process.env.CHELCOACH_ANALYSIS_PROVIDER = "scotty";
    process.env.CHELCOACH_SCOTTIE_ENABLED = "true";
    process.env.SCOTTY_BASE_URL = "https://scotty.example";
    process.env.SCOTTY_SIGNING_SECRET = "distinct-scotty-secret-value";
    process.env.CHELCOACH_RECONCILE_SECRET = "distinct-reconcile-secret";
    process.env.CHELCOACH_CLEANUP_SECRET = "distinct-cleanup-secret";
    const cfg = loadChelCoachConfig();
    const ready = computeReadiness(cfg);
    assert.equal(ready.mediaStorageReady, false);
  });
});

describe("object key design", () => {
  it("server-generates owner/upload/source without filename/email/gamertag", () => {
    const owner = "11111111-1111-4111-8111-111111111111";
    const upload = "22222222-2222-4222-8222-222222222222";
    const key = gameplayObjectKey(owner, upload);
    assert.equal(key, `${owner}/${upload}/source`);
    assert.ok(!key.includes("@"));
    assert.ok(!key.toLowerCase().includes("gamertag"));
    assert.ok(!key.includes(".mp4"));
    assert.ok(!key.includes("MyClip"));
  });

  it("derived frame keys use confirmation segment", () => {
    const key = derivedFrameObjectKey("owner-a", "upload-b", "frame-c");
    assert.equal(key, "owner-a/upload-b/confirmation/frame-c.jpg");
  });

  it("resumable endpoint targets storage upload path", () => {
    assert.equal(
      resumableUploadEndpoint("https://example.supabase.co"),
      "https://example.supabase.co/storage/v1/upload/resumable",
    );
  });
});

describe("supabase adapter write boundary", () => {
  it("rejects server openWriteStream (browser TUS only)", async () => {
    const storage = createSupabaseMediaObjectStorage({
      enabled: true,
      url: "https://example.supabase.co",
      anonKey: "anon",
      serviceRoleKey: "service",
      gameplayBucket: "chelcoach-gameplay",
      derivedBucket: "chelcoach-derived-media",
    });
    await assert.rejects(
      () =>
        storage.openWriteStream({
          objectKey: "o/u/source",
          contentType: "video/mp4",
          maxBytes: 1000,
        }),
      /STORAGE_UPLOAD_FAILED|resumable/,
    );
  });
});
