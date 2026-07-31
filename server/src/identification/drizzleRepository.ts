/**
 * Postgres-backed player identification repository (Step 10).
 * Frame image binaries are never stored in Postgres — only metadata + storage keys.
 */
import { and, eq, gt, isNull, lte } from "drizzle-orm";
import { getDb } from "../db/client";
import {
  confirmationFrames,
  playerCandidates,
  playerConfirmations,
  playerIdentifications,
  processingLeases,
} from "../db/schema";
import type {
  ConfirmationFrameRecord,
  PlayerCandidateRecord,
  PlayerConfirmationRecord,
  PlayerIdentificationRecord,
  ProcessingLeaseRecord,
} from "./types";
import type { IdentificationRepository } from "./repository";

function idRecToRow(rec: PlayerIdentificationRecord) {
  return {
    id: rec.identificationId,
    uploadId: rec.uploadId,
    ownerId: rec.ownerId,
    analysisJobId: rec.analysisJobId ?? null,
    contractVersion: rec.contractVersion,
    status: rec.status,
    detected: rec.detected,
    userConfirmed: rec.userConfirmed,
    confirmationId: rec.confirmationId ?? null,
    provider: rec.provider,
    record: rec as unknown as Record<string, unknown>,
    expiresAt: new Date(rec.expiresAt),
    createdAt: new Date(rec.createdAt),
    updatedAt: new Date(rec.updatedAt),
  };
}

function rowToIdentification(
  row: typeof playerIdentifications.$inferSelect,
): PlayerIdentificationRecord {
  const stored = row.record as PlayerIdentificationRecord;
  return {
    ...stored,
    identificationId: row.id,
    uploadId: row.uploadId,
    ownerId: row.ownerId,
    analysisJobId: row.analysisJobId ?? undefined,
    contractVersion: row.contractVersion,
    status: row.status as PlayerIdentificationRecord["status"],
    detected: row.detected,
    userConfirmed: row.userConfirmed,
    confirmationId: row.confirmationId ?? undefined,
    provider: row.provider as PlayerIdentificationRecord["provider"],
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
  };
}

function rowToFrame(row: typeof confirmationFrames.$inferSelect): ConfirmationFrameRecord {
  return {
    frameId: row.id,
    uploadId: row.uploadId,
    ownerId: row.ownerId,
    identificationId: row.identificationId,
    storageObjectKey: row.storageObjectKey,
    timestampSec: row.timestampSec,
    mimeType: row.mimeType as ConfirmationFrameRecord["mimeType"],
    width: row.width,
    height: row.height,
    byteSize: row.byteSize,
    expiresAt: row.expiresAt.toISOString(),
    deletedAt: row.deletedAt?.toISOString(),
    createdAt: row.createdAt.toISOString(),
  };
}

function rowToCandidate(row: typeof playerCandidates.$inferSelect): PlayerCandidateRecord {
  const payload = row.payload as PlayerCandidateRecord;
  return {
    ...payload,
    candidateId: row.id,
    uploadId: row.uploadId,
    identificationId: row.identificationId,
    representativeFrameId: row.representativeFrameId,
    expiresAt: row.expiresAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  };
}

function rowToConfirmation(
  row: typeof playerConfirmations.$inferSelect,
): PlayerConfirmationRecord {
  const payload = row.payload as PlayerConfirmationRecord;
  return {
    ...payload,
    confirmationId: row.id,
    identificationId: row.identificationId,
    uploadId: row.uploadId,
    ownerId: row.ownerId,
    selectedCandidateId: row.selectedCandidateId,
    selectedFrameId: row.selectedFrameId,
    confirmedAt: row.confirmedAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  };
}

function rowToLease(row: typeof processingLeases.$inferSelect): ProcessingLeaseRecord {
  return {
    leaseId: row.id,
    uploadId: row.uploadId,
    analysisJobId: row.analysisJobId,
    acquiredAt: row.acquiredAt.toISOString(),
    heartbeatAt: row.heartbeatAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    releasedAt: row.releasedAt?.toISOString(),
    status: row.status as ProcessingLeaseRecord["status"],
  };
}

export class DrizzleIdentificationRepository implements IdentificationRepository {
  async createIdentification(rec: PlayerIdentificationRecord): Promise<PlayerIdentificationRecord> {
    const db = getDb();
    const existing = await this.getByUploadId(rec.uploadId);
    if (existing) return existing;
    const [row] = await db.insert(playerIdentifications).values(idRecToRow(rec)).returning();
    return rowToIdentification(row);
  }

  async getIdentification(id: string): Promise<PlayerIdentificationRecord | undefined> {
    const db = getDb();
    const [row] = await db
      .select()
      .from(playerIdentifications)
      .where(eq(playerIdentifications.id, id))
      .limit(1);
    return row ? rowToIdentification(row) : undefined;
  }

  async getByUploadId(uploadId: string): Promise<PlayerIdentificationRecord | undefined> {
    const db = getDb();
    const [row] = await db
      .select()
      .from(playerIdentifications)
      .where(eq(playerIdentifications.uploadId, uploadId))
      .limit(1);
    return row ? rowToIdentification(row) : undefined;
  }

  async updateIdentification(
    id: string,
    patch: Partial<PlayerIdentificationRecord>,
  ): Promise<PlayerIdentificationRecord> {
    const db = getDb();
    return db.transaction(async (tx) => {
      const [cur] = await tx
        .select()
        .from(playerIdentifications)
        .where(eq(playerIdentifications.id, id))
        .for("update");
      if (!cur) throw new Error("IDENTIFICATION_NOT_FOUND");
      const merged: PlayerIdentificationRecord = {
        ...rowToIdentification(cur),
        ...patch,
        identificationId: id,
        updatedAt: new Date().toISOString(),
      };
      const [row] = await tx
        .update(playerIdentifications)
        .set({
          status: merged.status,
          detected: merged.detected,
          userConfirmed: merged.userConfirmed,
          confirmationId: merged.confirmationId ?? null,
          analysisJobId: merged.analysisJobId ?? null,
          provider: merged.provider,
          record: merged as unknown as Record<string, unknown>,
          expiresAt: new Date(merged.expiresAt),
          updatedAt: new Date(merged.updatedAt),
        })
        .where(eq(playerIdentifications.id, id))
        .returning();
      return rowToIdentification(row);
    });
  }

  async createFrame(rec: ConfirmationFrameRecord): Promise<ConfirmationFrameRecord> {
    const db = getDb();
    const [row] = await db
      .insert(confirmationFrames)
      .values({
        id: rec.frameId,
        uploadId: rec.uploadId,
        identificationId: rec.identificationId,
        ownerId: rec.ownerId,
        storageObjectKey: rec.storageObjectKey,
        timestampSec: rec.timestampSec,
        mimeType: rec.mimeType,
        width: rec.width,
        height: rec.height,
        byteSize: rec.byteSize,
        expiresAt: new Date(rec.expiresAt),
        deletedAt: rec.deletedAt ? new Date(rec.deletedAt) : null,
        createdAt: new Date(rec.createdAt),
      })
      .returning();
    return rowToFrame(row);
  }

  async getFrame(frameId: string): Promise<ConfirmationFrameRecord | undefined> {
    const db = getDb();
    const [row] = await db
      .select()
      .from(confirmationFrames)
      .where(eq(confirmationFrames.id, frameId))
      .limit(1);
    return row ? rowToFrame(row) : undefined;
  }

  async listFrames(identificationId: string): Promise<ConfirmationFrameRecord[]> {
    const db = getDb();
    const rows = await db
      .select()
      .from(confirmationFrames)
      .where(
        and(
          eq(confirmationFrames.identificationId, identificationId),
          isNull(confirmationFrames.deletedAt),
        ),
      );
    return rows.map(rowToFrame);
  }

  async markFrameDeleted(frameId: string): Promise<void> {
    const db = getDb();
    await db
      .update(confirmationFrames)
      .set({ deletedAt: new Date() })
      .where(eq(confirmationFrames.id, frameId));
  }

  async createCandidate(rec: PlayerCandidateRecord): Promise<PlayerCandidateRecord> {
    const db = getDb();
    const [row] = await db
      .insert(playerCandidates)
      .values({
        id: rec.candidateId,
        uploadId: rec.uploadId,
        identificationId: rec.identificationId,
        representativeFrameId: rec.representativeFrameId,
        payload: rec as unknown as Record<string, unknown>,
        expiresAt: new Date(rec.expiresAt),
        createdAt: new Date(rec.createdAt),
      })
      .returning();
    return rowToCandidate(row);
  }

  async getCandidate(candidateId: string): Promise<PlayerCandidateRecord | undefined> {
    const db = getDb();
    const [row] = await db
      .select()
      .from(playerCandidates)
      .where(eq(playerCandidates.id, candidateId))
      .limit(1);
    return row ? rowToCandidate(row) : undefined;
  }

  async listCandidates(identificationId: string): Promise<PlayerCandidateRecord[]> {
    const db = getDb();
    const rows = await db
      .select()
      .from(playerCandidates)
      .where(eq(playerCandidates.identificationId, identificationId));
    return rows.map(rowToCandidate);
  }

  async replaceCandidates(
    identificationId: string,
    candidates: PlayerCandidateRecord[],
  ): Promise<PlayerCandidateRecord[]> {
    const db = getDb();
    return db.transaction(async (tx) => {
      await tx
        .delete(playerCandidates)
        .where(eq(playerCandidates.identificationId, identificationId));
      if (candidates.length === 0) return [];
      const rows = await tx
        .insert(playerCandidates)
        .values(
          candidates.map((rec) => ({
            id: rec.candidateId,
            uploadId: rec.uploadId,
            identificationId: rec.identificationId,
            representativeFrameId: rec.representativeFrameId,
            payload: rec as unknown as Record<string, unknown>,
            expiresAt: new Date(rec.expiresAt),
            createdAt: new Date(rec.createdAt),
          })),
        )
        .returning();
      return rows.map(rowToCandidate);
    });
  }

  async createConfirmation(rec: PlayerConfirmationRecord): Promise<PlayerConfirmationRecord> {
    const db = getDb();
    const [row] = await db
      .insert(playerConfirmations)
      .values({
        id: rec.confirmationId,
        identificationId: rec.identificationId,
        uploadId: rec.uploadId,
        ownerId: rec.ownerId,
        selectedCandidateId: rec.selectedCandidateId,
        selectedFrameId: rec.selectedFrameId,
        payload: rec as unknown as Record<string, unknown>,
        confirmedAt: new Date(rec.confirmedAt),
        createdAt: new Date(rec.createdAt),
      })
      .returning();
    return rowToConfirmation(row);
  }

  async getConfirmation(id: string): Promise<PlayerConfirmationRecord | undefined> {
    const db = getDb();
    const [row] = await db
      .select()
      .from(playerConfirmations)
      .where(eq(playerConfirmations.id, id))
      .limit(1);
    return row ? rowToConfirmation(row) : undefined;
  }

  async getConfirmationByIdentification(
    identificationId: string,
  ): Promise<PlayerConfirmationRecord | undefined> {
    const db = getDb();
    const [row] = await db
      .select()
      .from(playerConfirmations)
      .where(eq(playerConfirmations.identificationId, identificationId))
      .limit(1);
    return row ? rowToConfirmation(row) : undefined;
  }

  async acquireLease(rec: ProcessingLeaseRecord): Promise<ProcessingLeaseRecord> {
    const db = getDb();
    const now = new Date();
    // Expire any still-marked-active leases that have passed expiry (stale recovery).
    await db
      .update(processingLeases)
      .set({ status: "expired", releasedAt: now })
      .where(
        and(
          eq(processingLeases.uploadId, rec.uploadId),
          eq(processingLeases.status, "active"),
          lte(processingLeases.expiresAt, now),
        ),
      );

    const active = await this.getActiveLease(rec.uploadId);
    if (active) {
      // Do not steal a valid lease — return existing for idempotent callers.
      return active;
    }

    const [row] = await db
      .insert(processingLeases)
      .values({
        id: rec.leaseId,
        uploadId: rec.uploadId,
        analysisJobId: rec.analysisJobId,
        status: "active",
        acquiredAt: new Date(rec.acquiredAt),
        heartbeatAt: new Date(rec.heartbeatAt),
        expiresAt: new Date(rec.expiresAt),
        releasedAt: null,
      })
      .returning();
    return rowToLease(row);
  }

  async getActiveLease(uploadId: string): Promise<ProcessingLeaseRecord | undefined> {
    const db = getDb();
    const now = new Date();
    const rows = await db
      .select()
      .from(processingLeases)
      .where(
        and(
          eq(processingLeases.uploadId, uploadId),
          eq(processingLeases.status, "active"),
          gt(processingLeases.expiresAt, now),
          isNull(processingLeases.releasedAt),
        ),
      )
      .limit(1);
    return rows[0] ? rowToLease(rows[0]) : undefined;
  }

  async releaseLease(leaseId: string): Promise<void> {
    const db = getDb();
    await db
      .update(processingLeases)
      .set({ status: "released", releasedAt: new Date() })
      .where(eq(processingLeases.id, leaseId));
  }

  /** E2E / test helper — delete identification tree for one upload. */
  async deleteByUploadId(uploadId: string): Promise<boolean> {
    const db = getDb();
    const existing = await this.getByUploadId(uploadId);
    if (!existing) return false;
    await db.delete(playerIdentifications).where(eq(playerIdentifications.uploadId, uploadId));
    return true;
  }
}
