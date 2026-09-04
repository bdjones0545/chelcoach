import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  assertBootConfig,
  loadChelCoachConfig,
  resetChelCoachConfigCacheForTests,
  validateChelCoachConfig,
} from "./chelcoachConfig";
import { computeReadiness } from "./readiness";

const SUPABASE_TEST = {
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_ANON_KEY: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.test-anon-key",
  CHELCOACH_EXISTING_AUTH_PROVIDER: "supabase",
} as const;

describe("chelcoach central config (Step 10)", () => {
  it("blocks development auth claimed ready in production", () => {
    resetChelCoachConfigCacheForTests();
    const config = loadChelCoachConfig({
      NODE_ENV: "production",
      CHELCOACH_AUTH_MODE: "development_session",
      CHELCOACH_PRODUCTION_AUTH_READY: "true",
      CORS_ORIGIN: "https://app.example.com",
      CHELCOACH_LEGACY_UPLOAD_ENABLED: "false",
      CHELCOACH_ANALYSIS_PROVIDER: "scotty",
      CHELCOACH_SCOTTIE_ENABLED: "true",
      SCOTTY_BASE_URL: "https://scotty.example",
      SCOTTY_SIGNING_SECRET: "a-real-signing-secret-value",
    });
    const result = validateChelCoachConfig(config);
    assert.ok(result.issues.some((i) => i.code === "DEV_AUTH_CLAIMED_READY"));
  });

  it("blocks simulator in production without override", () => {
    const config = loadChelCoachConfig({
      NODE_ENV: "production",
      CHELCOACH_AUTH_MODE: "existing_auth",
      CHELCOACH_PRODUCTION_AUTH_READY: "true",
      ...SUPABASE_TEST,
      CORS_ORIGIN: "https://app.example.com",
      CHELCOACH_LEGACY_UPLOAD_ENABLED: "false",
      CHELCOACH_ANALYSIS_PROVIDER: "simulator",
      CHELCOACH_SCOTTY_SIMULATOR_ENABLED: "true",
      CHELCOACH_SCOTTY_SIMULATOR_ALLOW_IN_PRODUCTION: "false",
    });
    const result = validateChelCoachConfig(config);
    assert.equal(result.ok, false);
    assert.ok(result.issues.some((i) => i.code === "SIMULATOR_IN_PRODUCTION"));
  });

  it("blocks fake and direct_anthropic in production", () => {
    for (const provider of ["fake", "direct_anthropic"] as const) {
      const config = loadChelCoachConfig({
        NODE_ENV: "production",
        CHELCOACH_AUTH_MODE: "existing_auth",
        CHELCOACH_PRODUCTION_AUTH_READY: "true",
        ...SUPABASE_TEST,
        CORS_ORIGIN: "https://app.example.com",
        CHELCOACH_LEGACY_UPLOAD_ENABLED: "false",
        CHELCOACH_ANALYSIS_PROVIDER: provider,
      });
      const result = validateChelCoachConfig(config);
      assert.equal(result.ok, false);
    }
  });

  it("maps existing_auth + supabase provider to supabase_auth", () => {
    const config = loadChelCoachConfig({
      NODE_ENV: "development",
      CHELCOACH_AUTH_MODE: "existing_auth",
      ...SUPABASE_TEST,
    });
    assert.equal(config.auth.mode, "supabase_auth");
    assert.equal(config.auth.configuredMode, "existing_auth");
    assert.equal(config.auth.allowSessionMint, false);
  });

  it("accepts CHELCOACH_AUTH_MODE=supabase_auth", () => {
    const config = loadChelCoachConfig({
      NODE_ENV: "development",
      CHELCOACH_AUTH_MODE: "supabase_auth",
      ...SUPABASE_TEST,
    });
    assert.equal(config.auth.mode, "supabase_auth");
    assert.equal(config.auth.supabaseUrlConfigured, true);
  });

  it("rejects supabase_auth without URL/anon key", () => {
    const config = loadChelCoachConfig({
      NODE_ENV: "development",
      CHELCOACH_AUTH_MODE: "supabase_auth",
    });
    const result = validateChelCoachConfig(config);
    assert.ok(result.issues.some((i) => i.code === "SUPABASE_URL_MISSING"));
    assert.ok(result.issues.some((i) => i.code === "SUPABASE_ANON_KEY_MISSING"));
  });

  it("assertBootConfig fails closed for production supabase_auth without server vars", () => {
    resetChelCoachConfigCacheForTests();
    assert.throws(
      () =>
        assertBootConfig({
          NODE_ENV: "production",
          CHELCOACH_AUTH_MODE: "supabase_auth",
          CHELCOACH_PRODUCTION_AUTH_READY: "true",
          CORS_ORIGIN: "https://app.example.com",
          CHELCOACH_LEGACY_UPLOAD_ENABLED: "false",
          CHELCOACH_ANALYSIS_SUBMISSION_ENABLED: "false",
          CHELCOACH_SCOTTIE_ENABLED: "false",
          CHELCOACH_PRODUCTION_MEDIA_STORAGE_READY: "false",
        }),
      (err: unknown) =>
        err instanceof Error &&
        (/CONFIG_INVALID/.test(err.message) ||
          /SUPABASE_URL_MISSING/.test(err.message) ||
          /SUPABASE_ANON_KEY_MISSING/.test(err.message)),
    );
  });

  it("rejects scotty disabled / missing signing", () => {
    const config = loadChelCoachConfig({
      NODE_ENV: "development",
      CHELCOACH_ANALYSIS_PROVIDER: "scotty",
      CHELCOACH_SCOTTIE_ENABLED: "false",
    });
    const result = validateChelCoachConfig(config);
    assert.ok(result.issues.some((i) => i.code === "SCOTTY_DISABLED"));
  });

  it("rejects callback enabled without signing secret", () => {
    const config = loadChelCoachConfig({
      NODE_ENV: "development",
      CHELCOACH_SCOTTY_CALLBACKS_ENABLED: "true",
    });
    const result = validateChelCoachConfig(config);
    assert.ok(result.issues.some((i) => i.code === "CALLBACK_UNSIGNED"));
  });

  it("rejects E2E mode in production", () => {
    const config = loadChelCoachConfig({
      NODE_ENV: "production",
      CHELCOACH_E2E_MODE: "1",
      CHELCOACH_AUTH_MODE: "existing_auth",
      CHELCOACH_PRODUCTION_AUTH_READY: "true",
      ...SUPABASE_TEST,
      CORS_ORIGIN: "https://app.example.com",
      CHELCOACH_LEGACY_UPLOAD_ENABLED: "false",
      CHELCOACH_ANALYSIS_PROVIDER: "scotty",
      CHELCOACH_SCOTTIE_ENABLED: "true",
      SCOTTY_BASE_URL: "https://scotty.example",
      SCOTTY_SIGNING_SECRET: "a-real-signing-secret-value",
    });
    const result = validateChelCoachConfig(config);
    assert.ok(result.issues.some((i) => i.code === "E2E_IN_PRODUCTION"));
  });

  it("rejects wildcard credentialed CORS", () => {
    const config = loadChelCoachConfig({
      NODE_ENV: "development",
      CORS_ORIGIN: "*",
      CORS_CREDENTIALS: "true",
    });
    const result = validateChelCoachConfig(config);
    assert.ok(result.issues.some((i) => i.code === "WILDCARD_CREDENTIALED_CORS"));
  });

  it("rejects shared internal secrets", () => {
    const config = loadChelCoachConfig({
      NODE_ENV: "production",
      CHELCOACH_AUTH_MODE: "existing_auth",
      CHELCOACH_PRODUCTION_AUTH_READY: "true",
      ...SUPABASE_TEST,
      CORS_ORIGIN: "https://app.example.com",
      CHELCOACH_LEGACY_UPLOAD_ENABLED: "false",
      CHELCOACH_ANALYSIS_PROVIDER: "scotty",
      CHELCOACH_SCOTTIE_ENABLED: "true",
      SCOTTY_BASE_URL: "https://scotty.example",
      SCOTTY_SIGNING_SECRET: "signing-secret-distinct",
      CHELCOACH_RECONCILE_SECRET: "same-secret-value",
      CHELCOACH_CLEANUP_SECRET: "same-secret-value",
    });
    const result = validateChelCoachConfig(config);
    assert.ok(result.issues.some((i) => i.code === "SHARED_INTERNAL_SECRETS"));
  });

  it("rejects invalid timeout", () => {
    assert.throws(
      () =>
        loadChelCoachConfig({
          NODE_ENV: "development",
          SCOTTY_REQUEST_TIMEOUT_MS: "not-a-number",
        }),
      /Invalid SCOTTY_REQUEST_TIMEOUT_MS/,
    );
  });

  it("rejects unsupported provider", () => {
    assert.throws(
      () =>
        loadChelCoachConfig({
          NODE_ENV: "development",
          CHELCOACH_ANALYSIS_PROVIDER: "magic",
        }),
      /Unsupported CHELCOACH_ANALYSIS_PROVIDER/,
    );
  });

  it("production readiness blocks analysis by default", () => {
    const config = loadChelCoachConfig({
      NODE_ENV: "production",
      CHELCOACH_AUTH_MODE: "development_session",
      CHELCOACH_PRODUCTION_AUTH_READY: "false",
      CORS_ORIGIN: "https://app.example.com",
      CHELCOACH_LEGACY_UPLOAD_ENABLED: "false",
      CHELCOACH_ANALYSIS_PROVIDER: "scotty",
      CHELCOACH_SCOTTIE_ENABLED: "true",
      SCOTTY_BASE_URL: "https://scotty.example",
      SCOTTY_SIGNING_SECRET: "a-real-signing-secret-value",
      DATABASE_URL: "postgresql://u:p@localhost/db",
    });
    const readiness = computeReadiness(config);
    assert.equal(readiness.analysisSubmissionEnabled, false);
    assert.ok(readiness.reasons.includes("PRODUCTION_AUTH_NOT_READY"));
    assert.ok(readiness.reasons.includes("ANALYSIS_SUBMISSION_NOT_EXPLICITLY_ENABLED"));
  });

  it("development allows analysis with session auth", () => {
    const config = loadChelCoachConfig({
      NODE_ENV: "development",
      CHELCOACH_AUTH_MODE: "development_session",
      CHELCOACH_ANALYSIS_PROVIDER: "simulator",
      CHELCOACH_SCOTTY_SIMULATOR_ENABLED: "true",
    });
    const readiness = computeReadiness(config);
    assert.equal(readiness.authReady, true);
    assert.equal(readiness.analysisSubmissionEnabled, true);
  });
});
