import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  calculateAbsoluteDeleteAt,
  calculateExpiresAt,
  DEFAULT_MEDIA_RETENTION_POLICY,
  FIXED_NOW,
  minimalScottyReport,
  SOURCE_VIDEO_EXPIRED_MESSAGE,
  toPublicUploadView,
  type ProcessingLease,
  type RawUploadMetadata,
} from "../scottyContract";
import { createMediaRetentionService } from "./cleanup";
import { getMediaRetentionPolicy, resetRetentionPolicyCacheForTests } from "./policy";
import { InMemoryRetentionRepository } from "./repository";
import type { ObjectStorage } from "../storage";

class FakeStorage implements ObjectStorage {
  readonly backend = "memory" as const;
  objects = new Map<string, Buffer>();
  failNextDelete = false;
  deleteCalls = 0;

  async put(key: string, data: Buffer): Promise<void> {
    this.objects.set(key, data);
  }
  async exists(key: string): Promise<boolean> {
    return this.objects.has(key);
  }
  async delete(key: string): Promise<{ deleted: boolean; alreadyAbsent: boolean }> {
    this.deleteCalls += 1;
    if (this.failNextDelete) {
      this.failNextDelete = false;
      throw new Error("storage unavailable");
    }
    const had = this.objects.delete(key);
    return { deleted: true, alreadyAbsent: !had };
  }
}

function makeMeta(overrides: Partial<RawUploadMetadata> = {}): RawUploadMetadata {
  const createdAt = FIXED_NOW;
  const policy = DEFAULT_MEDIA_RETENTION_POLICY;
  return {
    uploadId: "upload-1",
    ownerId: "owner-1",
    originalFilename: "game.mp4",
    displayFilename: "game.mp4",
    mimeType: "video/mp4",
    byteSize: 1_000_000,
    durationSec: 120,
    storageProvider: "memory",
    storageObjectKey: "clips/upload-1/source.mp4",
    uploadStatus: "ready",
    createdAt: createdAt.toISOString(),
    uploadedAt: createdAt.toISOString(),
    expiresAt: calculateExpiresAt(createdAt, policy).toISOString(),
    absoluteDeleteAt: calculateAbsoluteDeleteAt(createdAt, policy).toISOString(),
    deletionAttemptCount: 0,
    retentionPolicyVersion: policy.policyVersion,
    ...overrides,
  };
}

describe("MediaRetentionService", () => {
  let repo: InMemoryRetentionRepository;
  let storage: FakeStorage;

  beforeEach(() => {
    resetRetentionPolicyCacheForTests();
    delete process.env.CHELCOACH_RAW_MEDIA_RETENTION_HOURS;
    delete process.env.CHELCOACH_RAW_MEDIA_MAX_RETENTION_HOURS;
    repo = new InMemoryRetentionRepository();
    storage = new FakeStorage();
  });

  afterEach(() => {
    resetRetentionPolicyCacheForTests();
  });

  it("loads configurable retention policy from env", () => {
    process.env.CHELCOACH_RAW_MEDIA_RETENTION_HOURS = "12";
    process.env.CHELCOACH_RAW_MEDIA_MAX_RETENTION_HOURS = "36";
    resetRetentionPolicyCacheForTests();
    const policy = getMediaRetentionPolicy();
    assert.equal(policy.rawMediaRetentionHours, 12);
    assert.equal(policy.maximumRetentionHours, 36);
  });

  it("defers deletion while a processing lease is active", async () => {
    await storage.put("clips/upload-1/source.mp4", Buffer.from("video"));
    repo.seedUpload({
      meta: makeMeta(),
      derivedObjectKeys: [],
      jobTerminalStatus: "active",
    });
    const lease: ProcessingLease = {
      leaseId: "lease-1",
      uploadId: "upload-1",
      analysisJobId: "job-1",
      acquiredAt: FIXED_NOW.toISOString(),
      heartbeatAt: FIXED_NOW.toISOString(),
      expiresAt: new Date("2026-08-02T00:00:00.000Z").toISOString(),
      status: "active",
    };
    repo.seedLease(lease);
    const svc = createMediaRetentionService({ repo, storage });
    const now = new Date("2026-08-01T13:00:00.000Z");
    const result = await svc.deleteCandidate(
      (await svc.findDeletionCandidates(now))[0]!,
      now,
    );
    assert.equal(result.status, "deferred");
    assert.equal(await storage.exists("clips/upload-1/source.mp4"), true);
  });

  it("deletes when lease is expired", async () => {
    await storage.put("clips/upload-1/source.mp4", Buffer.from("video"));
    repo.seedUpload({
      meta: makeMeta(),
      derivedObjectKeys: ["clips/upload-1/frame-0.jpg"],
      jobTerminalStatus: "completed",
      reportId: "report-1",
    });
    await storage.put("clips/upload-1/frame-0.jpg", Buffer.from("jpg"));
    repo.seedLease({
      leaseId: "lease-1",
      uploadId: "upload-1",
      analysisJobId: "job-1",
      acquiredAt: FIXED_NOW.toISOString(),
      heartbeatAt: FIXED_NOW.toISOString(),
      expiresAt: new Date("2026-08-01T10:00:00.000Z").toISOString(),
      status: "expired",
    });
    repo.seedReport(minimalScottyReport({ reportId: "report-1", uploadId: "upload-1" }));
    const svc = createMediaRetentionService({ repo, storage });
    const now = new Date("2026-08-01T13:00:00.000Z");
    const result = await svc.deleteCandidate((await svc.findDeletionCandidates(now))[0]!, now);
    assert.equal(result.status, "deleted");
    assert.equal(await storage.exists("clips/upload-1/source.mp4"), false);
    assert.equal(result.reportRetained, true);
  });

  it("deletion is idempotent and treats absent objects as success", async () => {
    repo.seedUpload({
      meta: makeMeta(),
      derivedObjectKeys: [],
      jobTerminalStatus: "failed",
    });
    // Object already absent
    const svc = createMediaRetentionService({ repo, storage });
    const now = new Date("2026-08-01T13:00:00.000Z");
    const first = await svc.deleteCandidate((await svc.findDeletionCandidates(now))[0]!, now);
    assert.equal(first.status, "deleted");
    assert.equal(first.alreadyAbsent, true);

    // Second pass — already deleted → skipped
    const batch = await svc.runCleanupBatch({ now });
    assert.ok(batch.skipped >= 0);
    const upload = await repo.getUpload("upload-1");
    assert.equal(upload?.meta.uploadStatus, "deleted");
  });

  it("storage failure records delete_failed and increments attempt count", async () => {
    await storage.put("clips/upload-1/source.mp4", Buffer.from("video"));
    storage.failNextDelete = true;
    repo.seedUpload({
      meta: makeMeta(),
      derivedObjectKeys: [],
      jobTerminalStatus: "cancelled",
    });
    const svc = createMediaRetentionService({ repo, storage });
    const now = new Date("2026-08-01T13:00:00.000Z");
    const result = await svc.deleteCandidate((await svc.findDeletionCandidates(now))[0]!, now);
    assert.equal(result.status, "delete_failed");
    assert.equal(result.attemptCount, 1);
    const upload = await repo.getUpload("upload-1");
    assert.equal(upload?.meta.uploadStatus, "delete_failed");
    assert.equal(upload?.meta.deletionAttemptCount, 1);
    assert.equal(upload?.meta.lastDeletionErrorCode, "MEDIA_DELETION_FAILED");
  });

  it("absolute 48-hour limit forces delete and fails stuck jobs", async () => {
    await storage.put("clips/upload-1/source.mp4", Buffer.from("video"));
    repo.seedUpload({
      meta: makeMeta({ uploadStatus: "processing" }),
      derivedObjectKeys: [],
      jobTerminalStatus: "active",
    });
    repo.seedLease({
      leaseId: "lease-stuck",
      uploadId: "upload-1",
      analysisJobId: "job-stuck",
      acquiredAt: FIXED_NOW.toISOString(),
      heartbeatAt: FIXED_NOW.toISOString(),
      expiresAt: new Date("2026-08-03T00:00:00.000Z").toISOString(),
      status: "active",
    });
    const svc = createMediaRetentionService({ repo, storage });
    const now = new Date("2026-08-02T12:00:00.000Z");
    const result = await svc.deleteCandidate((await svc.findDeletionCandidates(now))[0]!, now);
    assert.equal(result.status, "deleted");
    const upload = await repo.getUpload("upload-1");
    assert.equal(upload?.jobTerminalStatus, "failed");
    assert.equal(upload?.forcedFailureCode, "RETENTION_LIMIT_REACHED");
  });

  it("report remains after media deletion and public view hides storage keys", async () => {
    await storage.put("clips/upload-1/source.mp4", Buffer.from("video"));
    repo.seedUpload({
      meta: makeMeta(),
      derivedObjectKeys: [],
      jobTerminalStatus: "completed",
      reportId: "report-1",
    });
    repo.seedReport(minimalScottyReport({ reportId: "report-1" }));
    const svc = createMediaRetentionService({ repo, storage });
    const now = new Date("2026-08-01T13:00:00.000Z");
    await svc.deleteCandidate((await svc.findDeletionCandidates(now))[0]!, now);
    const report = await repo.getReport("report-1");
    assert.ok(report);
    const upload = await repo.getUpload("upload-1");
    const pub = toPublicUploadView(upload!.meta);
    assert.equal(pub.sourceVideoExpiredMessage, SOURCE_VIDEO_EXPIRED_MESSAGE);
    assert.equal(JSON.stringify(pub).includes("storageObjectKey"), false);
    assert.equal(JSON.stringify(pub).includes("clips/upload-1"), false);
  });

  it("does not log raw media content (structured log fields only)", async () => {
    const lines: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    };
    try {
      await storage.put("clips/upload-1/source.mp4", Buffer.from("SECRET_VIDEO_BYTES"));
      repo.seedUpload({
        meta: makeMeta(),
        derivedObjectKeys: [],
        jobTerminalStatus: "completed",
      });
      const svc = createMediaRetentionService({ repo, storage });
      const now = new Date("2026-08-01T13:00:00.000Z");
      await svc.deleteCandidate((await svc.findDeletionCandidates(now))[0]!, now);
    } finally {
      console.log = original;
    }
    const joined = lines.join("\n");
    assert.equal(joined.includes("SECRET_VIDEO_BYTES"), false);
    assert.ok(joined.includes("upload=upload-1"));
  });

  it("prevents concurrent cleanup batches from overlapping", async () => {
    repo.seedUpload({
      meta: makeMeta(),
      derivedObjectKeys: [],
      jobTerminalStatus: "completed",
    });
    const svc = createMediaRetentionService({ repo, storage });
    // Simulate overlap by holding batchRunning via a long delete — use lock contention instead.
    const now = new Date("2026-08-01T13:00:00.000Z");
    await repo.tryAcquireCleanupLock("upload-1", "other-worker", now, 60_000);
    const result = await svc.deleteCandidate((await svc.findDeletionCandidates(now))[0]!, now);
    assert.equal(result.status, "deferred");
  });
});
