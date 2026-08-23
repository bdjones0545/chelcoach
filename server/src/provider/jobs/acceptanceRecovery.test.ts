/**
 * Acceptance-unknown recovery (P1).
 *
 * A submission whose provider call failed ambiguously is left with
 * submissionAcceptanceState=acceptance_unknown and no externalJobId. Synchronization needs that ID,
 * so the job could never advance: reconciliation re-selected it on every batch forever while it
 * stayed active and permanently consumed the owner's active-job quota — five such failures locked
 * the user out for good.
 *
 * These tests pin a bounded, non-resubmitting recovery: wait, then terminalize once.
 */
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { randomUUID } from "node:crypto";
import {
  loadChelCoachConfig,
  resetChelCoachConfigCacheForTests,
} from "../../config/chelcoachConfig";
import { resetScottyProviderForTests, setScottyProviderForTests } from "../factory";
import {
  InMemoryAnalysisJobRepository,
  getAnalysisJobRepository,
  resetAnalysisJobRepositoryForTests,
  setAnalysisJobRepositoryForTests,
} from "./jobRepository";
import { AnalysisReconciliationService } from "./reconciliationService";
import { synchronizeJob } from "./syncService";
import { isTerminalStatus } from "./transitions";
import type { AnalysisJob, CreateAnalysisJobInput } from "./types";
import type { ScottyProvider } from "../types";

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

const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;

function baseCreate(overrides: Partial<CreateAnalysisJobInput> = {}): CreateAnalysisJobInput {
  return {
    applicationRequestId: overrides.applicationRequestId ?? randomUUID(),
    uploadId: overrides.uploadId ?? randomUUID(),
    ownerId: overrides.ownerId ?? "own-acceptance",
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

/**
 * Age is read from createdAt, so backdating that field is exactly how a row stuck before this
 * change looks to reconciliation — which is what makes historical recovery work with no data repair.
 */
function backdate(repo: InMemoryAnalysisJobRepository, applicationRequestId: string, ageMs: number) {
  const internal = repo as unknown as { jobs: Map<string, AnalysisJob> };
  const job = internal.jobs.get(applicationRequestId);
  assert.ok(job, "job must exist to backdate");
  job.createdAt = new Date(Date.now() - ageMs).toISOString();
}

/** Counts every provider interaction so "no provider call" and "no resubmission" are provable. */
function countingProvider(counts: { submit: number; getJob: number; getReport: number }) {
  return {
    mode: "simulator",
    canServeProductionTraffic: false,
    async submitAnalysis() {
      counts.submit += 1;
      throw new Error("provider must not be called during acceptance recovery");
    },
    async getJob() {
      counts.getJob += 1;
      throw new Error("provider must not be called during acceptance recovery");
    },
    async getReport() {
      counts.getReport += 1;
      throw new Error("provider must not be called during acceptance recovery");
    },
  } as unknown as ScottyProvider;
}

let repo: InMemoryAnalysisJobRepository;
let counts: { submit: number; getJob: number; getReport: number };

async function seedAcceptanceUnknown(overrides: Partial<CreateAnalysisJobInput> = {}) {
  const created = await repo.createPendingSubmission(baseCreate(overrides));
  const unknown = await repo.markAcceptanceUnknown(created.applicationRequestId, created.version);
  assert.equal(unknown.submissionAcceptanceState, "acceptance_unknown");
  assert.equal(unknown.externalJobId, undefined, "the ambiguous failure left no external ID");
  return unknown;
}

beforeEach(() => {
  process.env.NODE_ENV = "test";
  process.env.CHELCOACH_FORCE_MEMORY_REPOS = "1";
  delete process.env.CHELCOACH_SUBMISSION_ACCEPTANCE_TIMEOUT_MS;
  resetChelCoachConfigCacheForTests();
  resetAnalysisJobRepositoryForTests();
  resetScottyProviderForTests();
  repo = new InMemoryAnalysisJobRepository();
  setAnalysisJobRepositoryForTests(repo);
  counts = { submit: 0, getJob: 0, getReport: 0 };
  setScottyProviderForTests(countingProvider(counts));
});

describe("acceptance-unknown recovery (P1)", () => {
  it("bounds the timeout with a validated default of 15 minutes", () => {
    resetChelCoachConfigCacheForTests();
    assert.equal(
      loadChelCoachConfig({}).provider.submissionAcceptanceTimeoutMs,
      DEFAULT_TIMEOUT_MS,
    );

    resetChelCoachConfigCacheForTests();
    assert.equal(
      loadChelCoachConfig({ CHELCOACH_SUBMISSION_ACCEPTANCE_TIMEOUT_MS: "60000" }).provider
        .submissionAcceptanceTimeoutMs,
      60_000,
    );

    // Out-of-range values are rejected rather than silently clamped: too small terminalizes healthy
    // in-flight work, too large disables the recovery entirely.
    for (const bad of ["4999", `${25 * 60 * 60 * 1000}`]) {
      resetChelCoachConfigCacheForTests();
      assert.throws(
        () => loadChelCoachConfig({ CHELCOACH_SUBMISSION_ACCEPTANCE_TIMEOUT_MS: bad }),
        `expected ${bad} to be rejected`,
      );
    }
  });

  it("leaves a young unresolved submission non-terminal and untouched", async () => {
    const job = await seedAcceptanceUnknown();

    const result = await synchronizeJob({
      applicationRequestId: job.applicationRequestId,
      trigger: "reconciliation",
    });

    assert.equal(result.job.canonicalStatus, "queued");
    assert.equal(isTerminalStatus(result.job.canonicalStatus), false);
    // markAcceptanceUnknown already stamps ANALYSIS_TIMEOUT; the point is that nothing has
    // escalated it to the terminal acceptance-timeout reason yet.
    assert.equal(result.job.safeErrorCode, "ANALYSIS_TIMEOUT");
    assert.notEqual(result.job.safeErrorCode, "SUBMISSION_ACCEPTANCE_TIMEOUT");
    assert.equal(result.job.version, job.version, "no write occurs inside the window");
    assert.deepEqual(counts, { submit: 0, getJob: 0, getReport: 0 });
  });

  it("terminalizes an expired unresolved submission as failed", async () => {
    const job = await seedAcceptanceUnknown();
    backdate(repo, job.applicationRequestId, DEFAULT_TIMEOUT_MS + 60_000);

    const result = await synchronizeJob({
      applicationRequestId: job.applicationRequestId,
      trigger: "reconciliation",
    });

    assert.equal(result.job.canonicalStatus, "failed");
    assert.equal(isTerminalStatus(result.job.canonicalStatus), true);
  });

  it("records SUBMISSION_ACCEPTANCE_TIMEOUT as the failure reason", async () => {
    const job = await seedAcceptanceUnknown();
    backdate(repo, job.applicationRequestId, DEFAULT_TIMEOUT_MS + 60_000);

    const result = await synchronizeJob({
      applicationRequestId: job.applicationRequestId,
      trigger: "reconciliation",
    });

    assert.equal(result.job.safeErrorCode, "SUBMISSION_ACCEPTANCE_TIMEOUT");
    assert.equal(result.job.retryable, false);
    assert.ok((result.job.safeErrorMessage ?? "").length > 0);
  });

  it("makes no provider call and never resubmits", async () => {
    const job = await seedAcceptanceUnknown();
    backdate(repo, job.applicationRequestId, DEFAULT_TIMEOUT_MS + 60_000);

    await synchronizeJob({
      applicationRequestId: job.applicationRequestId,
      trigger: "reconciliation",
    });

    // An uncertain response may mean the provider did accept the work; resubmitting would duplicate
    // it there. Failing closed is recoverable, duplicate provider jobs are not.
    assert.equal(counts.submit, 0, "no resubmission");
    assert.deepEqual(counts, { submit: 0, getJob: 0, getReport: 0 });

    const after = await repo.getByApplicationRequestId(job.applicationRequestId);
    assert.equal(after?.externalJobId, undefined, "no fake external ID may be invented");
  });

  it("releases the owner's active-job quota", async () => {
    const ownerId = "own-quota-release";
    const job = await seedAcceptanceUnknown({ ownerId });

    const before = (await repo.listByOwner(ownerId, 50)).filter((j) =>
      ACTIVE_JOB_STATUSES.has(j.canonicalStatus),
    );
    assert.equal(before.length, 1, "the stuck job holds a quota slot");

    backdate(repo, job.applicationRequestId, DEFAULT_TIMEOUT_MS + 60_000);
    await synchronizeJob({
      applicationRequestId: job.applicationRequestId,
      trigger: "reconciliation",
    });

    const after = (await repo.listByOwner(ownerId, 50)).filter((j) =>
      ACTIVE_JOB_STATUSES.has(j.canonicalStatus),
    );
    assert.equal(after.length, 0, "the slot is returned, so the owner may submit again");
  });

  it("is idempotent across repeated reconciliation and stops being a candidate", async () => {
    const job = await seedAcceptanceUnknown();
    backdate(repo, job.applicationRequestId, DEFAULT_TIMEOUT_MS + 60_000);

    const first = await synchronizeJob({
      applicationRequestId: job.applicationRequestId,
      trigger: "reconciliation",
    });
    const second = await synchronizeJob({
      applicationRequestId: job.applicationRequestId,
      trigger: "reconciliation",
    });
    const third = await synchronizeJob({
      applicationRequestId: job.applicationRequestId,
      trigger: "reconciliation",
    });

    assert.equal(second.job.version, first.job.version, "no further writes after terminalization");
    assert.equal(third.job.version, first.job.version);
    assert.equal(third.job.canonicalStatus, "failed", "terminal state never regresses to active");

    // The whole point of the bound: it must leave the reconciliation working set.
    const candidates = await repo.listReconciliationCandidates({ now: new Date(), limit: 50 });
    assert.equal(
      candidates.some((c) => c.applicationRequestId === job.applicationRequestId),
      false,
      "a settled job must stop looping in reconciliation",
    );
  });

  it("terminalizes at most once under concurrent reconcilers", async () => {
    const job = await seedAcceptanceUnknown();
    backdate(repo, job.applicationRequestId, DEFAULT_TIMEOUT_MS + 60_000);

    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        synchronizeJob({
          applicationRequestId: job.applicationRequestId,
          trigger: "reconciliation",
        }),
      ),
    );

    for (const r of results) {
      assert.equal(r.job.canonicalStatus, "failed", "every racer observes the settled state");
    }

    const final = await repo.getByApplicationRequestId(job.applicationRequestId);
    assert.equal(final?.version, job.version + 1, "exactly one version bump — a single transition");

    const events = await repo.listEvents(job.applicationRequestId, 50);
    assert.equal(
      events.filter((e) => e.eventType === "job_failed").length,
      1,
      "one terminal event, not four",
    );
    assert.equal(counts.submit, 0);
  });

  it("preserves normal synchronization when an externalJobId exists", async () => {
    const created = await repo.createPendingSubmission(baseCreate());
    const accepted = await repo.markAccepted({
      applicationRequestId: created.applicationRequestId,
      expectedVersion: created.version,
      externalJobId: "ext-job-123",
      acceptedAt: new Date().toISOString(),
      canonicalStatus: "analyzing_gameplay",
      pollAfterMs: 1000,
    });
    const unknown = await repo.markAcceptanceUnknown(
      accepted.applicationRequestId,
      accepted.version,
    );
    assert.equal(unknown.externalJobId, "ext-job-123");
    backdate(repo, unknown.applicationRequestId, DEFAULT_TIMEOUT_MS + 60_000);

    // Old enough to trip the timeout, but it has an external ID — the no-ID rule must not apply.
    // It takes the ordinary sync path instead, which queries the provider and (because this stub
    // throws) degrades gracefully rather than terminalizing.
    const result = await synchronizeJob({
      applicationRequestId: unknown.applicationRequestId,
      trigger: "reconciliation",
    });
    assert.equal(result.degraded, true, "provider failure degrades, it does not terminalize");

    const after = await repo.getByApplicationRequestId(unknown.applicationRequestId);
    assert.notEqual(
      after?.safeErrorCode,
      "SUBMISSION_ACCEPTANCE_TIMEOUT",
      "externally identifiable jobs must never be terminalized by the no-ID rule",
    );
    assert.equal(counts.getJob, 1, "normal synchronization still queries the provider");
  });

  it("repairs a historical stuck row through ordinary reconciliation", async () => {
    // No one-off data repair and no production mutation: a row stuck for days simply ages past the
    // bound and terminalizes on the next ordinary batch.
    const ownerId = "own-historical";
    const job = await seedAcceptanceUnknown({ ownerId });
    backdate(repo, job.applicationRequestId, 5 * 24 * 60 * 60 * 1000);

    const batch = await new AnalysisReconciliationService().runBatch({
      now: new Date(),
      limit: 25,
    });
    assert.ok(batch.examined >= 1, "the stuck row is still selected while active");

    const after = await repo.getByApplicationRequestId(job.applicationRequestId);
    assert.equal(after?.canonicalStatus, "failed");
    assert.equal(after?.safeErrorCode, "SUBMISSION_ACCEPTANCE_TIMEOUT");
    assert.equal(counts.submit, 0);

    const secondBatch = await new AnalysisReconciliationService().runBatch({
      now: new Date(),
      limit: 25,
    });
    assert.equal(
      secondBatch.applicationRequestIds.includes(job.applicationRequestId),
      false,
      "and it does not come back on the next batch",
    );
  });

  it("keeps the repaired job out of the owner's quota so they can submit again", async () => {
    const ownerId = "own-resubmit-allowed";
    const job = await seedAcceptanceUnknown({ ownerId });
    backdate(repo, job.applicationRequestId, DEFAULT_TIMEOUT_MS + 1);

    await synchronizeJob({
      applicationRequestId: job.applicationRequestId,
      trigger: "reconciliation",
    });

    // A fresh submission is a normal create — the terminalized job no longer blocks it.
    const next = await getAnalysisJobRepository().createPendingSubmission(baseCreate({ ownerId }));
    const active = (await repo.listByOwner(ownerId, 50)).filter((j) =>
      ACTIVE_JOB_STATUSES.has(j.canonicalStatus),
    );
    assert.equal(active.length, 1, "only the new submission holds a slot");
    assert.equal(active[0]?.applicationRequestId, next.applicationRequestId);
  });
});
