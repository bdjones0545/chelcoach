/**
 * Provider production-capability gate (P0).
 *
 * Configuration validation can only prove a provider is *configured*. It cannot see that an
 * implementation never reaches the network, which is how a fully-configured skeleton previously
 * reported ready and then failed every submission — after creating a durable job that consumed the
 * caller's active-job quota and could never be reconciled.
 *
 * These tests pin the fix: readiness asks the implementation whether it can serve production
 * traffic, and the existing submission gate turns a false answer into a refusal before any durable
 * state exists.
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  loadChelCoachConfig,
  resetChelCoachConfigCacheForTests,
} from "../config/chelcoachConfig";
import {
  assertAnalysisSubmissionReady,
  computeReadiness,
} from "../config/readiness";
import {
  getAnalysisJobRepository,
  resetAnalysisJobRepositoryForTests,
} from "./jobs/jobRepository";
import {
  providerCanServeProductionTraffic,
  resetScottyProviderForTests,
  setScottyProviderForTests,
} from "./factory";
import { DirectAnthropicProvider } from "./directAnthropicProvider";
import { FakeScottyProvider } from "./fakeProvider";
import { HttpScottyProvider } from "./httpScottyProvider";
import { NoopScottyRequestSigner } from "./signer";
import { SimulatorScottyProvider } from "./simulator/simulatorProvider";
import type { ScottyProvider } from "./types";

/**
 * Every control a production deployment is supposed to have, all satisfied. The only thing that can
 * make readiness fail from this baseline is the provider capability under test — which is the point:
 * it isolates capability from configuration.
 */
const PRODUCTION_ENV = {
  NODE_ENV: "production",
  CHELCOACH_AUTH_MODE: "existing_auth",
  CHELCOACH_EXISTING_AUTH_PROVIDER: "supabase",
  CHELCOACH_PRODUCTION_AUTH_READY: "true",
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_ANON_KEY: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.test-anon-key",
  SUPABASE_SERVICE_ROLE_KEY: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.test-service-role",
  DATABASE_URL: "postgresql://user:pass@db.example:5432/chelcoach",
  CHELCOACH_FORCE_MEMORY_REPOS: "0",
  CHELCOACH_MEDIA_STORAGE_MODE: "supabase_storage",
  CHELCOACH_PRODUCTION_MEDIA_STORAGE_READY: "true",
  CORS_ORIGIN: "https://app.example.com",
  CHELCOACH_LEGACY_UPLOAD_ENABLED: "false",
  CHELCOACH_ANALYSIS_PROVIDER: "scotty",
  CHELCOACH_SCOTTIE_ENABLED: "true",
  SCOTTY_BASE_URL: "https://scotty.example",
  SCOTTY_SIGNING_SECRET: "a-real-signing-secret-value",
} as const;

function productionConfig(overrides: Record<string, string> = {}) {
  resetChelCoachConfigCacheForTests();
  return loadChelCoachConfig({ ...PRODUCTION_ENV, ...overrides });
}

/** Readiness reads the explicit production enable from process.env, not the injected config map. */
function withSubmissionEnabled<T>(fn: () => T): T {
  const previous = process.env.CHELCOACH_ANALYSIS_SUBMISSION_ENABLED;
  process.env.CHELCOACH_ANALYSIS_SUBMISSION_ENABLED = "1";
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env.CHELCOACH_ANALYSIS_SUBMISSION_ENABLED;
    else process.env.CHELCOACH_ANALYSIS_SUBMISSION_ENABLED = previous;
  }
}

/**
 * A provider that would genuinely serve production traffic. Proves the gate is a real predicate
 * rather than a blanket "always false" — without it, tests 1-3 would pass on a broken gate.
 */
function capableScottyProvider(onSubmit: () => void): ScottyProvider {
  return {
    mode: "scotty",
    canServeProductionTraffic: true,
    async submitAnalysis() {
      onSubmit();
      throw new Error("not exercised in this suite");
    },
    async getJob() {
      throw new Error("not exercised in this suite");
    },
    async getReport() {
      throw new Error("not exercised in this suite");
    },
  } as unknown as ScottyProvider;
}

function incapableScottyProvider(onSubmit: () => void): ScottyProvider {
  return {
    mode: "scotty",
    canServeProductionTraffic: false,
    async submitAnalysis() {
      onSubmit();
      throw new Error("not exercised in this suite");
    },
    async getJob() {
      throw new Error("not exercised in this suite");
    },
    async getReport() {
      throw new Error("not exercised in this suite");
    },
  } as unknown as ScottyProvider;
}

afterEach(() => {
  resetScottyProviderForTests();
  resetChelCoachConfigCacheForTests();
});

describe("provider production capability (P0)", () => {
  it("declares every shipped provider incapable of production traffic", () => {
    // Each value is declared on the implementation itself; this pins the current truth so that
    // flipping one to true is a deliberate, reviewed act rather than an accident.
    assert.equal(
      new HttpScottyProvider(
        {
          provider: "scotty",
          scottyEnabled: true,
          scottyBaseUrl: "https://scotty.example",
          contractVersion: "1.0.0",
          requestTimeoutMs: 30_000,
          statusTimeoutMs: 10_000,
          reportTimeoutMs: 30_000,
          signingSecretConfigured: true,
          nodeEnv: "production",
          simulatorEnabled: false,
          simulatorAllowInProduction: false,
          simulatorDefaultScenario: "auto",
        },
        new NoopScottyRequestSigner(),
      ).canServeProductionTraffic,
      false,
      "HttpScottyProvider is a Step 4 skeleton and never reaches the network",
    );
    assert.equal(new FakeScottyProvider("accept").canServeProductionTraffic, false);
    assert.equal(new DirectAnthropicProvider().canServeProductionTraffic, false);
    assert.equal(new SimulatorScottyProvider({}).canServeProductionTraffic, false);
  });

  it("reports a fully configured skeleton Scotty provider as not production ready", () => {
    const config = productionConfig();
    const readiness = withSubmissionEnabled(() => computeReadiness(config));

    // Configuration itself is valid — no provider config issue is raised.
    assert.equal(
      readiness.reasons.includes("SCOTTY_DISABLED"),
      false,
      "config is genuinely valid; the failure must come from capability, not configuration",
    );
    assert.equal(readiness.providerReady, false);
  });

  it("records PROVIDER_NOT_IMPLEMENTED as the deterministic diagnostic", () => {
    const config = productionConfig();
    const readiness = withSubmissionEnabled(() => computeReadiness(config));

    assert.ok(
      readiness.reasons.includes("PROVIDER_NOT_IMPLEMENTED"),
      `expected PROVIDER_NOT_IMPLEMENTED, got: ${readiness.reasons.join(", ")}`,
    );
  });

  it("disables analysis submission when the provider cannot serve production traffic", () => {
    const config = productionConfig();
    const readiness = withSubmissionEnabled(() => computeReadiness(config));

    assert.equal(readiness.analysisSubmissionEnabled, false);
  });

  it("refuses the submission before any durable job, quota use, or provider call", async () => {
    resetAnalysisJobRepositoryForTests();
    let providerCalls = 0;
    setScottyProviderForTests(incapableScottyProvider(() => (providerCalls += 1)));

    const config = productionConfig();
    const ownerId = "own_capability_gate_probe";

    // Mirrors the order the route uses: the readiness gate runs before submitAnalysis is entered.
    withSubmissionEnabled(() => {
      assert.throws(
        () => assertAnalysisSubmissionReady(config),
        (err: Error & { code?: string; reasons?: string[] }) => {
          assert.equal(err.code, "ANALYSIS_NOT_READY", "maps to the 503 ANALYSIS_NOT_READY contract");
          assert.ok(err.reasons?.includes("PROVIDER_NOT_IMPLEMENTED"));
          return true;
        },
      );
    });

    assert.equal(providerCalls, 0, "no provider call may occur");

    const jobs = await getAnalysisJobRepository().listByOwner(ownerId, 50);
    assert.equal(jobs.length, 0, "no durable job may be created");
    // With no durable job there is no active-job row, so no quota is consumed and no
    // acceptance_unknown state can exist — the states that previously became unrecoverable.
    assert.equal(
      jobs.filter((j) => j.submissionAcceptanceState === "acceptance_unknown").length,
      0,
    );
  });

  it("keeps the existing fake-provider production restriction intact", () => {
    const config = productionConfig({ CHELCOACH_ANALYSIS_PROVIDER: "fake" });
    const readiness = withSubmissionEnabled(() => computeReadiness(config));

    assert.equal(readiness.providerReady, false);
    assert.ok(readiness.reasons.includes("FAKE_IN_PRODUCTION"));
  });

  it("keeps the existing direct_anthropic production restriction intact", () => {
    const config = productionConfig({ CHELCOACH_ANALYSIS_PROVIDER: "direct_anthropic" });
    const readiness = withSubmissionEnabled(() => computeReadiness(config));

    assert.equal(readiness.providerReady, false);
    assert.ok(readiness.reasons.includes("ANTHROPIC_IN_PRODUCTION"));
  });

  it("keeps the existing simulator production restriction intact", () => {
    const config = productionConfig({
      CHELCOACH_ANALYSIS_PROVIDER: "simulator",
      CHELCOACH_SCOTTY_SIMULATOR_ENABLED: "true",
      CHELCOACH_SCOTTY_SIMULATOR_ALLOW_IN_PRODUCTION: "false",
    });
    const readiness = withSubmissionEnabled(() => computeReadiness(config));

    assert.equal(readiness.providerReady, false);
    assert.ok(readiness.reasons.includes("SIMULATOR_IN_PRODUCTION"));
  });

  it("reports ready when a genuinely capable provider serves the same production config", () => {
    // The positive control. Same configuration as the failing cases above — only the declared
    // capability differs — so a gate that simply always returned false would fail here.
    let providerCalls = 0;
    setScottyProviderForTests(capableScottyProvider(() => (providerCalls += 1)));

    const config = productionConfig();
    const readiness = withSubmissionEnabled(() => computeReadiness(config));

    assert.equal(readiness.providerReady, true);
    assert.equal(
      readiness.reasons.includes("PROVIDER_NOT_IMPLEMENTED"),
      false,
      "a capable provider must not be flagged as unimplemented",
    );
    assert.equal(readiness.analysisSubmissionEnabled, true);
    assert.doesNotThrow(() => withSubmissionEnabled(() => assertAnalysisSubmissionReady(config)));
    assert.equal(providerCalls, 0, "readiness must never invoke the provider");
  });

  it("resolves capability from the implementation rather than the mode string", () => {
    // A capable instance registered for "scotty" wins over the skeleton class, proving the value is
    // read from the implementation and not inferred from the mode name.
    setScottyProviderForTests(capableScottyProvider(() => undefined));
    assert.equal(providerCanServeProductionTraffic("scotty"), true);

    resetScottyProviderForTests();
    assert.equal(providerCanServeProductionTraffic("scotty"), false);
    assert.equal(providerCanServeProductionTraffic("fake"), false);
    assert.equal(providerCanServeProductionTraffic("simulator"), false);
    assert.equal(providerCanServeProductionTraffic("direct_anthropic"), false);
  });

  it("leaves development provider behavior unchanged", () => {
    // Outside production the capability check does not apply, so local and CI flows on the fake
    // provider keep working exactly as before.
    resetChelCoachConfigCacheForTests();
    const config = loadChelCoachConfig({
      NODE_ENV: "development",
      CHELCOACH_AUTH_MODE: "development_session",
      CHELCOACH_ANALYSIS_PROVIDER: "fake",
    });
    const readiness = computeReadiness(config);

    assert.equal(readiness.providerReady, true, "fake stays usable in development");
    assert.equal(
      readiness.reasons.includes("PROVIDER_NOT_IMPLEMENTED"),
      false,
      "capability is a production concern only",
    );
    assert.equal(readiness.analysisSubmissionEnabled, true);
  });
});
