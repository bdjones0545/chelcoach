/**
 * Production scheduler contract (background jobs).
 *
 * Platform cron (Vercel) issues GET with `Authorization: Bearer <secret>`. Three internal routes
 * accepted only POST with a custom header, so their scheduled invocations hit the generic 404 and
 * failed silently — indistinguishable from a routing miss, with nothing alerting. Analysis
 * reconciliation had no cron entry at all, which meant the bounded acceptance-unknown recovery only
 * ran while a user happened to be polling in a browser.
 *
 * These tests pin the transport contract: what the scheduler actually sends must reach the
 * canonical service, and everything else must still fail closed.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { AddressInfo } from "node:net";
import { createApp } from "../app";
import { resetChelCoachConfigCacheForTests } from "../config/chelcoachConfig";
import { resetScottyProviderForTests, setScottyProviderForTests } from "../provider/factory";
import {
  InMemoryAnalysisJobRepository,
  resetAnalysisJobRepositoryForTests,
  setAnalysisJobRepositoryForTests,
} from "../provider/jobs/jobRepository";
import { resetRetentionPolicyCacheForTests } from "../retention/policy";
import type { AnalysisJob, CreateAnalysisJobInput } from "../provider/jobs/types";
import type { ScottyProvider } from "../provider/types";

const RECONCILE_SECRET = "scheduler-test-reconcile-secret";
const INSPECTION_SECRET = "scheduler-test-inspection-secret";
const DEFAULT_ACCEPTANCE_TIMEOUT_MS = 15 * 60 * 1000;

/** Mirrors the set submissionService uses for the per-owner active-job quota. */
const ACTIVE_JOB_STATUSES = new Set([
  "queued",
  "inspecting_input",
  "extracting_frames",
  "identifying_controlled_player",
  "awaiting_player_confirmation",
  "validating_player_identity",
  "analyzing_gameplay",
  "validating_report",
  "finalizing",
]);

let repo: InMemoryAnalysisJobRepository;
let providerCalls: number;

function neverCalledProvider(): ScottyProvider {
  return {
    mode: "simulator",
    canServeProductionTraffic: false,
    async submitAnalysis() {
      providerCalls += 1;
      throw new Error("provider must not be called");
    },
    async getJob() {
      providerCalls += 1;
      throw new Error("provider must not be called");
    },
    async getReport() {
      providerCalls += 1;
      throw new Error("provider must not be called");
    },
  } as unknown as ScottyProvider;
}

async function withServer(fn: (baseUrl: string) => Promise<void>) {
  const app = createApp();
  const server = app.listen(0);
  await new Promise<void>((r) => server.once("listening", () => r()));
  const { port } = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    server.close();
  }
}

/** Exactly what a Vercel cron sends: GET, bearer token, no body. */
function cronRequest(baseUrl: string, path: string, secret: string) {
  return fetch(`${baseUrl}${path}`, {
    method: "GET",
    headers: { authorization: `Bearer ${secret}` },
  });
}

function baseCreate(overrides: Partial<CreateAnalysisJobInput> = {}): CreateAnalysisJobInput {
  return {
    applicationRequestId: overrides.applicationRequestId ?? randomUUID(),
    uploadId: overrides.uploadId ?? randomUUID(),
    ownerId: overrides.ownerId ?? "own-scheduler",
    provider: overrides.provider ?? "simulator",
    contractVersion: "1.0.0",
    idempotencyKey: overrides.idempotencyKey ?? `idem-${randomUUID()}`,
    requestFingerprint: overrides.requestFingerprint ?? "fp-1",
    requestedCapabilities: {
      identifyControlledPlayer: true,
      analyzeGameplay: true,
      analyzeStrategies: true,
      analyzeFaceoffs: true,
      includeControlGuidance: true,
      generatePracticeDrills: true,
    },
    gameContext: {
      selectedGameTitle: "NHL 25",
      canonicalGameId: "nhl-25",
      supportStatus: "supported",
      mismatchState: "none",
    },
    uploadContext: {
      gameContext: {
        selectedGameTitle: "NHL 25",
        canonicalGameId: "nhl-25",
        supportStatus: "supported",
        mismatchState: "none",
      },
      playerContext: {
        platform: "xbox_series",
        controlScheme: "skill_stick",
        position: "C",
        gameMode: "eashl",
        jerseyNumber: 17,
        indicatorColor: "blue",
        teamSide: "home",
      },
      singlePlayerControl: true,
    },
    effectivePlayer: {
      position: "C",
      jerseyNumber: 17,
      indicatorColor: "blue",
      teamSide: "home",
      confidence: 0.9,
      confidenceLabel: "very_high",
      source: "user_confirmation",
      identificationId: "id-1",
      confirmationId: "conf-1",
      userConfirmed: true,
    },
    mediaClassification: "short_clip",
    ...overrides,
  };
}

function backdate(applicationRequestId: string, ageMs: number) {
  const internal = repo as unknown as { jobs: Map<string, AnalysisJob> };
  const job = internal.jobs.get(applicationRequestId);
  assert.ok(job, "job must exist to backdate");
  job.createdAt = new Date(Date.now() - ageMs).toISOString();
}

async function seedExpiredAcceptanceUnknown(ownerId: string) {
  const created = await repo.createPendingSubmission(baseCreate({ ownerId }));
  const unknown = await repo.markAcceptanceUnknown(created.applicationRequestId, created.version);
  assert.equal(unknown.submissionAcceptanceState, "acceptance_unknown");
  assert.equal(unknown.externalJobId, undefined);
  backdate(unknown.applicationRequestId, DEFAULT_ACCEPTANCE_TIMEOUT_MS + 60_000);
  return unknown;
}

beforeEach(() => {
  process.env.NODE_ENV = "test";
  process.env.CHELCOACH_FORCE_MEMORY_REPOS = "1";
  process.env.CHELCOACH_RECONCILE_SECRET = RECONCILE_SECRET;
  process.env.CHELCOACH_INSPECTION_WORKER_SECRET = INSPECTION_SECRET;
  delete process.env.CHELCOACH_INSPECTION_WORKER_INLINE;
  delete process.env.CHELCOACH_SUBMISSION_ACCEPTANCE_TIMEOUT_MS;
  resetChelCoachConfigCacheForTests();
  resetRetentionPolicyCacheForTests();
  resetAnalysisJobRepositoryForTests();
  resetScottyProviderForTests();
  repo = new InMemoryAnalysisJobRepository();
  setAnalysisJobRepositoryForTests(repo);
  providerCalls = 0;
  setScottyProviderForTests(neverCalledProvider());
});

afterEach(() => {
  delete process.env.CHELCOACH_RECONCILE_SECRET;
  delete process.env.CHELCOACH_INSPECTION_WORKER_SECRET;
  resetChelCoachConfigCacheForTests();
  resetScottyProviderForTests();
});

describe("production scheduler contract", () => {
  it("storage reconcile accepts the cron GET + bearer form", async () => {
    await withServer(async (baseUrl) => {
      const res = await cronRequest(
        baseUrl,
        "/api/internal/media/storage-reconcile",
        RECONCILE_SECRET,
      );
      assert.equal(res.status, 200);
      const body = (await res.json()) as Record<string, unknown>;
      // Proves the canonical operation ran, not merely that routing matched.
      assert.ok("examined" in body && "issueCount" in body && "repaired" in body);
    });
  });

  it("storage reconcile fails closed with no credentials", async () => {
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/internal/media/storage-reconcile`, { method: "GET" });
      assert.equal(res.status, 404);
      const body = (await res.json()) as { error?: string };
      assert.equal(body.error, "not_found", "never confirms the endpoint exists");
      assert.equal(
        JSON.stringify(body).includes(RECONCILE_SECRET),
        false,
        "no secret may appear in a response",
      );
    });
  });

  it("storage reconcile fails closed with a wrong bearer", async () => {
    await withServer(async (baseUrl) => {
      const res = await cronRequest(
        baseUrl,
        "/api/internal/media/storage-reconcile",
        "not-the-right-secret",
      );
      assert.equal(res.status, 404);
      assert.equal(((await res.json()) as { error?: string }).error, "not_found");
    });
  });

  it("inspection worker accepts the cron GET + bearer form", async () => {
    await withServer(async (baseUrl) => {
      const res = await cronRequest(
        baseUrl,
        "/api/internal/media/inspection-worker",
        INSPECTION_SECRET,
      );
      assert.equal(res.status, 200);
      const body = (await res.json()) as { mode?: string };
      // Default deployment posture: a wake signal only, never inline media work.
      assert.equal(body.mode, "wake");
    });
  });

  it("inspection worker fails closed on missing and wrong credentials", async () => {
    await withServer(async (baseUrl) => {
      const missing = await fetch(`${baseUrl}/api/internal/media/inspection-worker`, {
        method: "GET",
      });
      assert.equal(missing.status, 404);

      const wrong = await cronRequest(
        baseUrl,
        "/api/internal/media/inspection-worker",
        RECONCILE_SECRET, // a real secret, but for a different endpoint
      );
      assert.equal(wrong.status, 404, "endpoint secrets are not interchangeable");
    });
  });

  it("analysis reconcile accepts the cron GET + bearer form", async () => {
    await withServer(async (baseUrl) => {
      const res = await cronRequest(baseUrl, "/api/internal/analysis/reconcile", RECONCILE_SECRET);
      assert.equal(res.status, 200);
      const body = (await res.json()) as Record<string, unknown>;
      for (const key of ["examined", "advanced", "degraded", "unchanged", "failed"]) {
        assert.ok(key in body, `canonical runBatch result must include ${key}`);
      }
    });
  });

  it("analysis reconcile fails closed on missing and wrong credentials", async () => {
    await withServer(async (baseUrl) => {
      const missing = await fetch(`${baseUrl}/api/internal/analysis/reconcile`, { method: "GET" });
      assert.equal(missing.status, 404);

      const wrong = await cronRequest(
        baseUrl,
        "/api/internal/analysis/reconcile",
        "wrong-secret-value",
      );
      assert.equal(wrong.status, 404);
    });
  });

  it("preserves the existing POST + custom-header contracts", async () => {
    await withServer(async (baseUrl) => {
      const storage = await fetch(`${baseUrl}/api/internal/media/storage-reconcile`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-chelcoach-reconcile-secret": RECONCILE_SECRET,
        },
        body: JSON.stringify({ limit: 5 }),
      });
      assert.equal(storage.status, 200, "operators keep the header form");

      const worker = await fetch(`${baseUrl}/api/internal/media/inspection-worker`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-chelcoach-inspection-worker-secret": INSPECTION_SECRET,
        },
        body: JSON.stringify({}),
      });
      assert.equal(worker.status, 200);

      const analysis = await fetch(`${baseUrl}/api/internal/analysis/reconcile`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-chelcoach-reconcile-secret": RECONCILE_SECRET,
        },
        body: JSON.stringify({ limit: 10 }),
      });
      assert.equal(analysis.status, 200);
    });
  });

  it("schedules every background job that needs one, at the intended cadence", () => {
    const cfg = JSON.parse(
      readFileSync(resolve(import.meta.dirname, "../../../vercel.json"), "utf8"),
    ) as { crons: { path: string; schedule: string }[] };

    const scheduled = new Map(cfg.crons.map((c) => [c.path, c.schedule]));
    assert.equal(scheduled.get("/api/internal/media/cleanup"), "0 * * * *");
    assert.equal(scheduled.get("/api/internal/media/storage-reconcile"), "15 * * * *");
    assert.equal(scheduled.get("/api/internal/media/inspection-worker"), "* * * * *");
    // The addition: without this entry the P1 recovery only ran while someone was polling.
    assert.equal(scheduled.get("/api/internal/analysis/reconcile"), "* * * * *");
    assert.equal(cfg.crons.length, 4, "no stray schedules");
  });

  it("terminalizes an expired acceptance-unknown job through the cron-reached path", async () => {
    // The full chain the P1 fix depends on: cron contract -> route -> canonical service ->
    // bounded recovery. No browser activity anywhere in it.
    const ownerId = "own-cron-recovery";
    const job = await seedExpiredAcceptanceUnknown(ownerId);

    const before = (await repo.listByOwner(ownerId, 50)).filter((j) =>
      ACTIVE_JOB_STATUSES.has(j.canonicalStatus),
    );
    assert.equal(before.length, 1, "the stuck job holds a quota slot");

    await withServer(async (baseUrl) => {
      const res = await cronRequest(baseUrl, "/api/internal/analysis/reconcile", RECONCILE_SECRET);
      assert.equal(res.status, 200);
      assert.ok(((await res.json()) as { examined: number }).examined >= 1);
    });

    const after = await repo.getByApplicationRequestId(job.applicationRequestId);
    assert.equal(after?.canonicalStatus, "failed");
    assert.equal(after?.safeErrorCode, "SUBMISSION_ACCEPTANCE_TIMEOUT");

    const active = (await repo.listByOwner(ownerId, 50)).filter((j) =>
      ACTIVE_JOB_STATUSES.has(j.canonicalStatus),
    );
    assert.equal(active.length, 0, "quota released, so the owner may submit again");
    assert.equal(providerCalls, 0, "recovery never resubmits or calls the provider");
  });

  it("stays stable and idempotent across repeated cron invocations", async () => {
    const ownerId = "own-cron-idempotent";
    const job = await seedExpiredAcceptanceUnknown(ownerId);

    await withServer(async (baseUrl) => {
      for (let i = 0; i < 3; i += 1) {
        const res = await cronRequest(
          baseUrl,
          "/api/internal/analysis/reconcile",
          RECONCILE_SECRET,
        );
        assert.equal(res.status, 200, `invocation ${i + 1} must succeed`);
      }
    });

    const settled = await repo.getByApplicationRequestId(job.applicationRequestId);
    assert.equal(settled?.canonicalStatus, "failed");

    const events = await repo.listEvents(job.applicationRequestId, 50);
    assert.equal(
      events.filter((e) => e.eventType === "job_failed").length,
      1,
      "terminalized exactly once despite three cron ticks",
    );
    assert.equal(providerCalls, 0);
  });
});
