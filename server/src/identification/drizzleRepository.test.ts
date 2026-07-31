/**
 * Step 10 — Postgres integration tests for durable identification.
 * Skipped unless CHELCOACH_RUN_PG_TESTS=1 and DATABASE_URL is set.
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { getDb, isDbConfigured } from "../db/client";
import { mediaUploads } from "../db/schema";
import { DrizzleIdentificationRepository } from "./drizzleRepository";
import { setIdentificationRepositoryForTests } from "./repository";
import type { PlayerIdentificationRecord, PlayerCandidateRecord, ConfirmationFrameRecord, PlayerConfirmationRecord } from "./types";

const runPg = process.env.CHELCOACH_RUN_PG_TESTS === "1" && isDbConfigured();

async function seedUpload(uploadId: string, ownerId = "own-id-pg"): Promise<void> {
  const db = getDb();
  const now = new Date();
  await db.insert(mediaUploads).values({
    id: uploadId,
    ownerId,
    storageProvider: "memory",
    storageObjectKey: `obj-${uploadId}`,
    originalFilename: "g.mp4",
    displayFilename: "g.mp4",
    mimeType: "video/mp4",
    byteSize: 2048,
    uploadStatus: "ready",
    retentionPolicyVersion: "v1",
    expiresAt: new Date(now.getTime() + 86_400_000),
    absoluteDeleteAt: new Date(now.getTime() + 172_800_000),
    pendingExpiresAt: new Date(now.getTime() + 3600_000),
    gameplayContext: {
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
      },
      singlePlayerControl: true,
    },
  });
}

function baseIdentification(uploadId: string, ownerId: string): PlayerIdentificationRecord {
  const now = new Date().toISOString();
  return {
    identificationId: randomUUID(),
    uploadId,
    ownerId,
    contractVersion: "1.0.0",
    status: "awaiting_confirmation",
    detected: true,
    confidence: 0.82,
    confidenceLabel: "high",
    predictedPosition: "C",
    predictedJerseyNumber: 19,
    predictedIndicatorColor: "blue",
    predictedTeamSide: "home",
    evidenceTimestampsSec: [12],
    uncertainties: [],
    userConfirmed: false,
    provider: "fixture",
    additionalExtractionAttempts: 0,
    createdAt: now,
    updatedAt: now,
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    originalPrediction: {
      position: "C",
      jerseyNumber: 19,
      indicatorColor: "blue",
      teamSide: "home",
      confidence: 0.82,
    },
  };
}

describe("drizzle identification repository (postgres)", { skip: !runPg }, () => {
  const repo = new DrizzleIdentificationRepository();

  before(() => {
    setIdentificationRepositoryForTests(repo);
  });

  beforeEach(async () => {
    const db = getDb();
    await db.execute(sql`
      truncate table player_confirmations, player_candidates, confirmation_frames,
      player_identifications, processing_leases, media_cleanup_locks,
      scotty_analysis_job_events, scotty_analysis_reports, scotty_analysis_jobs,
      scotty_simulator_jobs, media_uploads cascade
    `);
  });

  after(() => undefined);

  it("persists identification and survives repository recreation", async () => {
    const uploadId = randomUUID();
    await seedUpload(uploadId);
    const created = await repo.createIdentification(baseIdentification(uploadId, "own-id-pg"));
    const fresh = new DrizzleIdentificationRepository();
    const loaded = await fresh.getIdentification(created.identificationId);
    assert.ok(loaded);
    assert.equal(loaded.status, "awaiting_confirmation");
    assert.equal(loaded.confidence, 0.82);
    assert.equal(loaded.originalPrediction?.jerseyNumber, 19);
  });

  it("candidates, frames, confirmation, and correction survive restart", async () => {
    const uploadId = randomUUID();
    await seedUpload(uploadId);
    const idRec = await repo.createIdentification(baseIdentification(uploadId, "own-id-pg"));
    const frame: ConfirmationFrameRecord = {
      frameId: randomUUID(),
      uploadId,
      ownerId: "own-id-pg",
      identificationId: idRec.identificationId,
      storageObjectKey: `frames/${uploadId}/f1.jpg`,
      timestampSec: 12,
      mimeType: "image/jpeg",
      width: 1280,
      height: 720,
      byteSize: 1200,
      expiresAt: idRec.expiresAt,
      createdAt: idRec.createdAt,
    };
    await repo.createFrame(frame);
    const candidate: PlayerCandidateRecord = {
      candidateId: randomUUID(),
      uploadId,
      identificationId: idRec.identificationId,
      representativeFrameId: frame.frameId,
      timestampSec: 12,
      boundingBox: { x: 0.1, y: 0.1, width: 0.2, height: 0.4 },
      position: "C",
      jerseyNumber: 19,
      indicatorColor: "blue",
      teamSide: "home",
      confidence: 0.82,
      evidenceSummary: "center ice",
      displayLabel: "#19 C",
      expiresAt: idRec.expiresAt,
      createdAt: idRec.createdAt,
    };
    await repo.replaceCandidates(idRec.identificationId, [candidate]);
    const confirmation: PlayerConfirmationRecord = {
      confirmationId: randomUUID(),
      identificationId: idRec.identificationId,
      uploadId,
      ownerId: "own-id-pg",
      selectedCandidateId: candidate.candidateId,
      selectedFrameId: frame.frameId,
      originalConfidence: 0.82,
      confirmedAt: new Date().toISOString(),
      source: "user",
      createdAt: new Date().toISOString(),
    };
    await repo.createConfirmation(confirmation);
    await repo.updateIdentification(idRec.identificationId, {
      userConfirmed: true,
      confirmationId: confirmation.confirmationId,
      status: "confirmed",
      contextCorrection: {
        jerseyNumber: 91,
        correctedAt: new Date().toISOString(),
      },
    });

    const restarted = new DrizzleIdentificationRepository();
    const frames = await restarted.listFrames(idRec.identificationId);
    const candidates = await restarted.listCandidates(idRec.identificationId);
    const conf = await restarted.getConfirmationByIdentification(idRec.identificationId);
    const updated = await restarted.getIdentification(idRec.identificationId);
    assert.equal(frames.length, 1);
    assert.equal(candidates.length, 1);
    assert.ok(conf);
    assert.equal(updated?.status, "confirmed");
    assert.equal(updated?.contextCorrection?.jerseyNumber, 91);
  });

  it("unresolved state survives restart", async () => {
    const uploadId = randomUUID();
    await seedUpload(uploadId);
    const idRec = await repo.createIdentification({
      ...baseIdentification(uploadId, "own-id-pg"),
      status: "unresolved",
      detected: false,
      errorCode: "PLAYER_IDENTITY_UNRESOLVED",
      errorMessage: "Could not identify controlled player.",
    });
    const restarted = new DrizzleIdentificationRepository();
    const loaded = await restarted.getByUploadId(uploadId);
    assert.equal(loaded?.status, "unresolved");
    assert.equal(loaded?.errorCode, "PLAYER_IDENTITY_UNRESOLVED");
    assert.equal(loaded?.identificationId, idRec.identificationId);
  });

  it("stale lease recovers; valid lease is visible", async () => {
    const uploadId = randomUUID();
    await seedUpload(uploadId);
    const past = new Date(Date.now() - 60_000).toISOString();
    await repo.acquireLease({
      leaseId: randomUUID(),
      uploadId,
      analysisJobId: "job-1",
      acquiredAt: past,
      heartbeatAt: past,
      expiresAt: past,
      status: "active",
    });
    // Stale expired — getActiveLease should miss it after acquire expires it.
    const active = await repo.getActiveLease(uploadId);
    assert.equal(active, undefined);

    const leaseId = randomUUID();
    const future = new Date(Date.now() + 60_000).toISOString();
    const now = new Date().toISOString();
    await repo.acquireLease({
      leaseId,
      uploadId,
      analysisJobId: "job-2",
      acquiredAt: now,
      heartbeatAt: now,
      expiresAt: future,
      status: "active",
    });
    const held = await repo.getActiveLease(uploadId);
    assert.equal(held?.leaseId, leaseId);
    await repo.releaseLease(leaseId);
    assert.equal(await repo.getActiveLease(uploadId), undefined);
  });
});
