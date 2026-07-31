/**
 * Controlled-player identification + confirmation service (Step 3).
 * No gameplay coaching report generation.
 */
import {
  MAX_CONFIRMATION_FRAMES,
  MAX_PLAYER_CANDIDATES,
  SCOTTY_CONTRACT_VERSION,
  boundingBoxSchema,
  confidenceRequiresConfirmation,
  correctIdentificationRequestSchema,
  noneOfTheAboveRequestSchema,
  playerConfirmationSubmitSchema,
  playerCandidateSchema,
  publicPlayerIdentificationSchema,
  startPlayerIdentificationRequestSchema,
  type PublicPlayerIdentification,
  type ScottyErrorCode,
} from "../scottyContract";
import {
  getPlayerIdentityConfidenceThreshold,
  retentionNoticeText,
} from "../retention/policy";
import { getUploadRepository, type MediaUploadRecord } from "../uploads/repository";
import { getProfileRepository } from "../profile/repository";
import { getConfirmationFrameExtractor } from "./extractor";
import {
  getControlledPlayerIdentifier,
  type FixtureScenario,
} from "./fixtureIdentifier";
import {
  deleteFrameObject,
  frameObjectKey,
  openFrameReadStream,
  writeFrameBytes,
} from "./frameStore";
import {
  getIdentificationRepository,
  newId,
} from "./repository";
import { assertIdentificationTransition } from "./transitions";
import type {
  ConfirmationFrameRecord,
  PlayerCandidateRecord,
  PlayerIdentificationRecord,
} from "./types";

export class IdentificationServiceError extends Error {
  constructor(
    public httpStatus: number,
    public code: ScottyErrorCode | "INVALID_REQUEST",
    message: string,
  ) {
    super(message);
    this.name = "IdentificationServiceError";
  }
}

function logEvent(event: string, fields: Record<string, string | number | boolean | undefined>): void {
  const parts = Object.entries(fields)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${v}`);
  console.log(`[chelcoach-identity] event=${event} ${parts.join(" ")}`);
}

function allowFixtureSelection(): boolean {
  return (
    process.env.NODE_ENV === "test" ||
    process.env.CHELCOACH_ALLOW_IDENTITY_FIXTURES === "1" ||
    process.env.NODE_ENV !== "production"
  );
}

async function requireOwnedReadyUpload(
  ownerId: string,
  uploadId: string,
): Promise<MediaUploadRecord> {
  const upload = await getUploadRepository().get(uploadId);
  if (!upload) throw new IdentificationServiceError(404, "UPLOAD_NOT_FOUND", "Upload not found.");
  if (upload.ownerId !== ownerId) {
    throw new IdentificationServiceError(403, "FORBIDDEN", "You don't have access to this upload.");
  }
  if (upload.uploadStatus === "deleted" || upload.uploadStatus === "expired") {
    throw new IdentificationServiceError(
      410,
      upload.uploadStatus === "deleted" ? "MEDIA_ALREADY_DELETED" : "UPLOAD_EXPIRED",
      upload.uploadStatus === "deleted"
        ? "The source gameplay video has already been deleted."
        : "This upload has expired.",
    );
  }
  if (upload.uploadStatus !== "ready") {
    throw new IdentificationServiceError(409, "UPLOAD_NOT_READY", "This upload is not ready.");
  }
  if (new Date(upload.expiresAt).getTime() <= Date.now()) {
    throw new IdentificationServiceError(410, "UPLOAD_EXPIRED", "This upload has expired.");
  }
  if (!upload.trustedMedia) {
    throw new IdentificationServiceError(409, "UPLOAD_NOT_READY", "Trusted media metadata missing.");
  }
  return upload;
}

function toPublic(
  rec: PlayerIdentificationRecord,
  frames: ConfirmationFrameRecord[],
  candidates: PlayerCandidateRecord[],
  upload: MediaUploadRecord,
): PublicPlayerIdentification {
  const publicFrames = frames
    .filter((f) => !f.deletedAt)
    .slice(0, MAX_CONFIRMATION_FRAMES)
    .map((f) => ({
      frameId: f.frameId,
      uploadId: f.uploadId,
      timestampSec: f.timestampSec,
      mimeType: f.mimeType,
      width: f.width,
      height: f.height,
      byteSize: f.byteSize,
      accessUrl: `/api/uploads/${f.uploadId}/player-confirmation/frames/${f.frameId}`,
      expiresAt: f.expiresAt,
    }));

  const publicCandidates = candidates.slice(0, MAX_PLAYER_CANDIDATES).map((c) =>
    playerCandidateSchema.parse({
      candidateId: c.candidateId,
      uploadId: c.uploadId,
      representativeFrameId: c.representativeFrameId,
      timestampSec: c.timestampSec,
      boundingBox: c.boundingBox,
      position: c.position,
      jerseyNumber: c.jerseyNumber,
      indicatorColor: c.indicatorColor,
      teamSide: c.teamSide,
      confidence: c.confidence,
      evidenceSummary: c.evidenceSummary,
      thumbnailUrl: `/api/uploads/${c.uploadId}/player-confirmation/frames/${c.representativeFrameId}`,
      displayLabel: c.displayLabel,
      expiresAt: c.expiresAt,
    }),
  );

  return publicPlayerIdentificationSchema.parse({
    identificationId: rec.identificationId,
    uploadId: rec.uploadId,
    contractVersion: rec.contractVersion,
    status: rec.status,
    detected: rec.detected,
    confidence: rec.confidence,
    confidenceLabel: rec.confidenceLabel,
    player:
      rec.status === "identified" || rec.status === "confirmed"
        ? {
            position: rec.userConfirmed
              ? (rec.contextCorrection?.position ?? rec.predictedPosition)
              : rec.predictedPosition,
            jerseyNumber: rec.userConfirmed
              ? (rec.contextCorrection?.jerseyNumber ?? rec.predictedJerseyNumber)
              : rec.predictedJerseyNumber,
            indicatorColor: rec.userConfirmed
              ? (rec.contextCorrection?.indicatorColor ?? rec.predictedIndicatorColor)
              : rec.predictedIndicatorColor,
            teamSide: rec.userConfirmed
              ? (rec.contextCorrection?.teamSide ?? rec.predictedTeamSide)
              : rec.predictedTeamSide,
          }
        : rec.status === "confirmation_required"
          ? {
              position: rec.predictedPosition,
              jerseyNumber: rec.predictedJerseyNumber,
              indicatorColor: rec.predictedIndicatorColor,
              teamSide: rec.predictedTeamSide,
            }
          : undefined,
    uncertainties: rec.uncertainties,
    userConfirmed: rec.userConfirmed,
    confirmationId: rec.confirmationId,
    frames: publicFrames,
    candidates: publicCandidates,
    additionalExtractionAvailable: rec.additionalExtractionAttempts < 1,
    sourceExpiresAt: upload.expiresAt,
    retentionNotice: `Complete player confirmation before the source video expires. ${retentionNoticeText()}`,
    errorCode: rec.errorCode,
    errorMessage: rec.errorMessage,
  });
}

async function withLease<T>(uploadId: string, purpose: string, fn: () => Promise<T>): Promise<T> {
  const repo = getIdentificationRepository();
  const now = new Date();
  const leaseId = newId();
  try {
    await repo.acquireLease({
      leaseId,
      uploadId,
      analysisJobId: `identity-${purpose}-${leaseId}`,
      acquiredAt: now.toISOString(),
      heartbeatAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 60_000).toISOString(),
      status: "active",
    });
  } catch (err) {
    if ((err as { code?: string }).code === "PROCESSING_LEASE_CONFLICT") {
      throw new IdentificationServiceError(
        409,
        "PROCESSING_LEASE_CONFLICT",
        "This upload is busy with another processing task.",
      );
    }
    throw err;
  }
  try {
    return await fn();
  } finally {
    await repo.releaseLease(leaseId);
  }
}

async function persistCandidatesAndFrames(
  upload: MediaUploadRecord,
  identification: PlayerIdentificationRecord,
  result: Awaited<ReturnType<ReturnType<typeof getControlledPlayerIdentifier>["identify"]>>,
): Promise<{ frames: ConfirmationFrameRecord[]; candidates: PlayerCandidateRecord[] }> {
  const repo = getIdentificationRepository();
  const timestamps = [...new Set(result.evidenceTimestampsSec)].slice(0, MAX_CONFIRMATION_FRAMES);
  const extracted = await getConfirmationFrameExtractor().extract({
    uploadId: upload.uploadId,
    objectKey: upload.storageObjectKey,
    requestedTimestamps: timestamps.length ? timestamps : [1],
  });

  const frames: ConfirmationFrameRecord[] = [];
  for (const frame of extracted) {
    const frameId = newId();
    const key = frameObjectKey(upload.ownerId, upload.uploadId, frameId);
    await writeFrameBytes(key, frame.bytes);
    const rec: ConfirmationFrameRecord = {
      frameId,
      uploadId: upload.uploadId,
      ownerId: upload.ownerId,
      identificationId: identification.identificationId,
      storageObjectKey: key,
      timestampSec: frame.timestampSec,
      mimeType: frame.mimeType,
      width: frame.width,
      height: frame.height,
      byteSize: frame.bytes.length,
      expiresAt: upload.expiresAt,
      createdAt: new Date().toISOString(),
    };
    await repo.createFrame(rec);
    frames.push(rec);
  }
  logEvent("candidate_frames_extracted", {
    uploadId: upload.uploadId,
    identificationId: identification.identificationId,
    frameCount: frames.length,
  });

  const frameByTs = new Map(frames.map((f) => [f.timestampSec, f]));
  const defaultFrame = frames[0];
  const candidates: PlayerCandidateRecord[] = [];
  for (const draft of result.candidates.slice(0, MAX_PLAYER_CANDIDATES)) {
    const box = boundingBoxSchema.parse(draft.boundingBox);
    const frame = frameByTs.get(draft.timestampSec) ?? defaultFrame;
    if (!frame) continue;
    const candidate: PlayerCandidateRecord = {
      candidateId: newId(),
      uploadId: upload.uploadId,
      identificationId: identification.identificationId,
      representativeFrameId: frame.frameId,
      timestampSec: draft.timestampSec,
      boundingBox: box,
      position: draft.position,
      jerseyNumber: draft.jerseyNumber,
      indicatorColor: draft.indicatorColor,
      teamSide: draft.teamSide,
      confidence: draft.confidence,
      evidenceSummary: draft.evidenceSummary,
      displayLabel: draft.displayLabel,
      expiresAt: upload.expiresAt,
      createdAt: new Date().toISOString(),
    };
    candidates.push(candidate);
  }
  await repo.replaceCandidates(identification.identificationId, candidates);
  return { frames, candidates };
}

export async function startOrGetIdentification(
  ownerId: string,
  uploadId: string,
  body: unknown,
): Promise<PublicPlayerIdentification> {
  const parsed = startPlayerIdentificationRequestSchema.safeParse(body ?? {});
  if (!parsed.success) {
    throw new IdentificationServiceError(400, "INVALID_REQUEST", "Invalid identification request.");
  }

  const upload = await requireOwnedReadyUpload(ownerId, uploadId);
  const repo = getIdentificationRepository();
  const existing = await repo.getByUploadId(uploadId);

  // Idempotent: return existing terminal / in-progress results.
  if (existing) {
    if (existing.status === "checking") {
      // Concurrent start (e.g. React Strict Mode remount) — wait for the in-flight run
      // instead of failing the second caller with a hard 409.
      for (let i = 0; i < 60; i++) {
        await new Promise((r) => setTimeout(r, 50));
        const again = await repo.getByUploadId(uploadId);
        if (!again) break;
        if (again.status !== "checking") {
          const frames = await repo.listFrames(again.identificationId);
          const candidates = await repo.listCandidates(again.identificationId);
          return toPublic(again, frames, candidates, upload);
        }
      }
      throw new IdentificationServiceError(
        409,
        "PLAYER_IDENTIFICATION_ALREADY_RUNNING",
        "Player identification is already in progress.",
      );
    }
    const frames = await repo.listFrames(existing.identificationId);
    const candidates = await repo.listCandidates(existing.identificationId);
    return toPublic(existing, frames, candidates, upload);
  }

  const fixtureScenario =
    allowFixtureSelection() && parsed.data.fixtureScenario
      ? (parsed.data.fixtureScenario as FixtureScenario)
      : undefined;

  const now = new Date().toISOString();
  const identificationId = newId();
  let rec = await repo.createIdentification({
    identificationId,
    uploadId,
    ownerId,
    contractVersion: SCOTTY_CONTRACT_VERSION,
    status: "not_started",
    detected: false,
    confidence: 0,
    confidenceLabel: "unverified",
    predictedPosition: "unknown",
    predictedJerseyNumber: null,
    predictedIndicatorColor: null,
    predictedTeamSide: "unknown",
    evidenceTimestampsSec: [],
    uncertainties: [],
    userConfirmed: false,
    provider: "fixture",
    fixtureScenario,
    additionalExtractionAttempts: 0,
    createdAt: now,
    updatedAt: now,
    expiresAt: upload.expiresAt,
  });

  assertIdentificationTransition("not_started", "checking");
  rec = await repo.updateIdentification(identificationId, { status: "checking" });
  logEvent("identification_started", {
    uploadId,
    identificationId,
    ownerId,
  });

  return withLease(uploadId, "identify", async () => {
    try {
      if (fixtureScenario === "expired_upload") {
        assertIdentificationTransition("checking", "expired");
        rec = await repo.updateIdentification(identificationId, {
          status: "expired",
          errorCode: "UPLOAD_EXPIRED",
          errorMessage: "This upload has expired.",
        });
        logEvent("identification_expired", { uploadId, identificationId });
        throw new IdentificationServiceError(410, "UPLOAD_EXPIRED", "This upload has expired.");
      }

      const result = await getControlledPlayerIdentifier().identify({
        uploadId,
        ownerId,
        gameContext: upload.context.gameContext,
        playerContext: upload.context.playerContext,
        mediaMetadata: upload.trustedMedia!,
        fixtureScenario,
      });

      // Never call paid / live Scotty in this phase — fixture only.
      if (result.provider !== "fixture" && result.provider !== "local_simulator") {
        throw new IdentificationServiceError(500, "PLAYER_IDENTIFICATION_FAILED", "Invalid provider.");
      }

      if (result.failed) {
        assertIdentificationTransition("checking", "failed");
        rec = await repo.updateIdentification(identificationId, {
          status: "failed",
          detected: false,
          confidence: result.confidence,
          confidenceLabel: result.confidenceLabel,
          uncertainties: result.uncertainties,
          provider: result.provider,
          fixtureScenario: result.fixtureScenario,
          errorCode: "PLAYER_IDENTIFICATION_FAILED",
          errorMessage: result.errorMessage ?? "Identification failed.",
        });
        logEvent("identification_failed", {
          uploadId,
          identificationId,
          errorCode: "PLAYER_IDENTIFICATION_FAILED",
        });
        throw new IdentificationServiceError(
          422,
          "PLAYER_IDENTIFICATION_FAILED",
          result.errorMessage ?? "We couldn't identify your controlled player.",
        );
      }

      const threshold = getPlayerIdentityConfidenceThreshold();
      const needsConfirmation =
        result.confirmationRequired || confidenceRequiresConfirmation(result.confidence, threshold);

      const basePatch = {
        detected: result.detected,
        confidence: result.confidence,
        confidenceLabel: result.confidenceLabel,
        predictedPosition: result.position,
        predictedJerseyNumber: result.jerseyNumber,
        predictedIndicatorColor: result.indicatorColor,
        predictedTeamSide: result.teamSide,
        evidenceTimestampsSec: result.evidenceTimestampsSec,
        uncertainties: result.uncertainties,
        userConfirmed: false,
        provider: result.provider,
        fixtureScenario: result.fixtureScenario,
        originalPrediction: {
          position: result.position,
          jerseyNumber: result.jerseyNumber,
          indicatorColor: result.indicatorColor,
          teamSide: result.teamSide,
          confidence: result.confidence,
        },
      };

      if (!needsConfirmation) {
        assertIdentificationTransition("checking", "identified");
        rec = await repo.updateIdentification(identificationId, {
          ...basePatch,
          status: "identified",
        });
        logEvent("identification_completed", {
          uploadId,
          identificationId,
          confidence: result.confidence,
          state: "identified",
        });
        return toPublic(rec, [], [], upload);
      }

      assertIdentificationTransition("checking", "confirmation_required");
      const { frames, candidates } = await persistCandidatesAndFrames(upload, rec, result);
      rec = await repo.updateIdentification(identificationId, {
        ...basePatch,
        status: "confirmation_required",
      });
      logEvent("confirmation_required", {
        uploadId,
        identificationId,
        confidence: result.confidence,
        candidateCount: candidates.length,
        frameCount: frames.length,
      });
      return toPublic(rec, frames, candidates, upload);
    } catch (err) {
      if (err instanceof IdentificationServiceError) throw err;
      if ((err as { code?: string }).code === "FRAME_EXTRACTION_FAILED") {
        await repo.updateIdentification(identificationId, {
          status: "failed",
          errorCode: "FRAME_EXTRACTION_FAILED",
          errorMessage: "We couldn't extract confirmation frames from this video.",
        });
        throw new IdentificationServiceError(
          422,
          "FRAME_EXTRACTION_FAILED",
          "We couldn't extract confirmation frames from this video.",
        );
      }
      throw err;
    }
  });
}

export async function getIdentification(
  ownerId: string,
  uploadId: string,
): Promise<PublicPlayerIdentification> {
  try {
    const upload = await requireOwnedReadyUpload(ownerId, uploadId);
    const rec = await getIdentificationRepository().getByUploadId(uploadId);
    if (!rec) {
      throw new IdentificationServiceError(404, "UPLOAD_NOT_FOUND", "Identification not started.");
    }
    const frames = await getIdentificationRepository().listFrames(rec.identificationId);
    const candidates = await getIdentificationRepository().listCandidates(rec.identificationId);
    return toPublic(rec, frames, candidates, upload);
  } catch (err) {
    if (
      err instanceof IdentificationServiceError &&
      (err.code === "UPLOAD_EXPIRED" || err.code === "MEDIA_ALREADY_DELETED")
    ) {
      const uploadRow = await getUploadRepository().get(uploadId);
      if (!uploadRow || uploadRow.ownerId !== ownerId) throw err;
      const rec = await getIdentificationRepository().getByUploadId(uploadId);
      if (!rec) throw err;
      if (rec.status !== "expired") {
        await getIdentificationRepository().updateIdentification(rec.identificationId, {
          status: "expired",
          errorCode: err.code as ScottyErrorCode,
        });
      }
      const updated = await getIdentificationRepository().getIdentification(rec.identificationId);
      return toPublic(updated!, [], [], uploadRow);
    }
    throw err;
  }
}

export async function submitConfirmation(
  ownerId: string,
  uploadId: string,
  body: unknown,
): Promise<PublicPlayerIdentification> {
  const parsed = playerConfirmationSubmitSchema.safeParse(body);
  if (!parsed.success) {
    throw new IdentificationServiceError(400, "PLAYER_CONFIRMATION_INVALID", "Invalid confirmation.");
  }
  if (parsed.data.uploadId !== uploadId) {
    throw new IdentificationServiceError(400, "PLAYER_CONFIRMATION_INVALID", "Upload mismatch.");
  }

  const upload = await requireOwnedReadyUpload(ownerId, uploadId);
  const repo = getIdentificationRepository();
  const rec = await repo.getByUploadId(uploadId);
  if (!rec) throw new IdentificationServiceError(404, "UPLOAD_NOT_FOUND", "Identification not found.");

  // Idempotent same confirmation.
  if (rec.status === "confirmed" && rec.confirmationId) {
    const existing = await repo.getConfirmation(rec.confirmationId);
    if (existing && existing.selectedCandidateId === parsed.data.selectedCandidateId) {
      const frames = await repo.listFrames(rec.identificationId);
      const candidates = await repo.listCandidates(rec.identificationId);
      return toPublic(rec, frames, candidates, upload);
    }
    throw new IdentificationServiceError(
      409,
      "PLAYER_CONFIRMATION_INVALID",
      "A different confirmation already exists. Use the correction flow.",
    );
  }

  if (rec.status !== "confirmation_required") {
    throw new IdentificationServiceError(
      409,
      "PLAYER_CONFIRMATION_INVALID",
      "Confirmation is not required in the current state.",
    );
  }

  const candidate = await repo.getCandidate(parsed.data.selectedCandidateId);
  if (!candidate || candidate.uploadId !== uploadId) {
    throw new IdentificationServiceError(404, "PLAYER_CANDIDATE_NOT_FOUND", "Candidate not found.");
  }
  if (new Date(candidate.expiresAt).getTime() <= Date.now()) {
    throw new IdentificationServiceError(410, "PLAYER_CANDIDATE_EXPIRED", "Candidate expired.");
  }

  const frame = await repo.getFrame(parsed.data.representativeFrame.frameId);
  if (!frame || frame.uploadId !== uploadId || frame.deletedAt) {
    throw new IdentificationServiceError(404, "PLAYER_FRAME_NOT_FOUND", "Frame not found.");
  }
  if (new Date(frame.expiresAt).getTime() <= Date.now()) {
    throw new IdentificationServiceError(410, "PLAYER_CANDIDATE_EXPIRED", "Frame expired.");
  }

  return withLease(uploadId, "confirm", async () => {
    const confirmationId = newId();
    await repo.createConfirmation({
      confirmationId,
      identificationId: rec.identificationId,
      uploadId,
      ownerId,
      selectedCandidateId: candidate.candidateId,
      selectedFrameId: frame.frameId,
      confirmedPosition: parsed.data.confirmedPosition ?? candidate.position,
      confirmedJerseyNumber: parsed.data.confirmedJerseyNumber ?? candidate.jerseyNumber ?? undefined,
      confirmedIndicatorColor:
        parsed.data.confirmedIndicatorColor ?? candidate.indicatorColor ?? undefined,
      confirmedTeamSide: parsed.data.confirmedTeamSide ?? candidate.teamSide,
      originalPredictedCandidateId: undefined,
      originalConfidence: rec.confidence,
      confirmedAt: parsed.data.confirmedAt,
      source: "user",
      createdAt: new Date().toISOString(),
    });

    assertIdentificationTransition("confirmation_required", "confirmed");
    const updated = await repo.updateIdentification(rec.identificationId, {
      status: "confirmed",
      userConfirmed: true,
      confirmationId,
      contextCorrection: {
        position: parsed.data.confirmedPosition ?? candidate.position,
        jerseyNumber: parsed.data.confirmedJerseyNumber ?? candidate.jerseyNumber ?? undefined,
        indicatorColor:
          parsed.data.confirmedIndicatorColor ?? candidate.indicatorColor ?? undefined,
        teamSide: parsed.data.confirmedTeamSide ?? candidate.teamSide,
        correctedAt: parsed.data.confirmedAt,
      },
      // Preserve original prediction fields on the record.
      predictedPosition: rec.originalPrediction?.position ?? rec.predictedPosition,
      predictedJerseyNumber: rec.originalPrediction?.jerseyNumber ?? rec.predictedJerseyNumber,
      predictedIndicatorColor:
        rec.originalPrediction?.indicatorColor ?? rec.predictedIndicatorColor,
      predictedTeamSide: rec.originalPrediction?.teamSide ?? rec.predictedTeamSide,
    });

    // Delete derived frames after confirmation (no longer required).
    const frames = await repo.listFrames(rec.identificationId);
    for (const f of frames) {
      await deleteFrameObject(f.storageObjectKey).catch(() => undefined);
      await repo.markFrameDeleted(f.frameId);
    }

    logEvent("user_confirmation_submitted", {
      uploadId,
      identificationId: rec.identificationId,
      confidence: rec.confidence,
      state: "confirmed",
    });

    const candidates = await repo.listCandidates(rec.identificationId);
    return toPublic(updated, [], candidates, upload);
  });
}

export async function correctIdentification(
  ownerId: string,
  uploadId: string,
  body: unknown,
): Promise<PublicPlayerIdentification> {
  const parsed = correctIdentificationRequestSchema.safeParse(body ?? {});
  if (!parsed.success) {
    throw new IdentificationServiceError(400, "INVALID_REQUEST", "Invalid correction request.");
  }
  const upload = await requireOwnedReadyUpload(ownerId, uploadId);
  const repo = getIdentificationRepository();
  const rec = await repo.getByUploadId(uploadId);
  if (!rec) throw new IdentificationServiceError(404, "UPLOAD_NOT_FOUND", "Identification not found.");
  if (rec.status !== "identified") {
    throw new IdentificationServiceError(
      409,
      "PLAYER_CONFIRMATION_INVALID",
      "Only high-confidence results can be corrected this way.",
    );
  }

  return withLease(uploadId, "correct", async () => {
    assertIdentificationTransition("identified", "confirmation_required");
    const result = await getControlledPlayerIdentifier().identify({
      uploadId,
      ownerId,
      gameContext: upload.context.gameContext,
      playerContext: upload.context.playerContext,
      mediaMetadata: upload.trustedMedia!,
      fixtureScenario: "low_confidence_multiple_players",
    });
    const { frames, candidates } = await persistCandidatesAndFrames(upload, rec, result);
    const updated = await repo.updateIdentification(rec.identificationId, {
      status: "confirmation_required",
      uncertainties: ["User reported: that is not my player", ...result.uncertainties],
      confidence: result.confidence,
      confidenceLabel: result.confidenceLabel,
    });
    logEvent("user_correction_submitted", {
      uploadId,
      identificationId: rec.identificationId,
      state: "confirmation_required",
    });
    return toPublic(updated, frames, candidates, upload);
  });
}

export async function noneOfTheAbove(
  ownerId: string,
  uploadId: string,
  body: unknown,
): Promise<PublicPlayerIdentification> {
  const parsed = noneOfTheAboveRequestSchema.safeParse(body ?? {});
  if (!parsed.success) {
    throw new IdentificationServiceError(400, "INVALID_REQUEST", "Invalid request.");
  }
  const upload = await requireOwnedReadyUpload(ownerId, uploadId);
  const repo = getIdentificationRepository();
  const rec = await repo.getByUploadId(uploadId);
  if (!rec || rec.status !== "confirmation_required") {
    throw new IdentificationServiceError(
      409,
      "PLAYER_CONFIRMATION_INVALID",
      "None-of-the-above is only available during confirmation.",
    );
  }

  return withLease(uploadId, "none", async () => {
    let next = rec;
    if (parsed.data.hints) {
      next = await repo.updateIdentification(rec.identificationId, {
        contextCorrection: {
          ...parsed.data.hints,
          correctedAt: new Date().toISOString(),
        },
      });
      if (parsed.data.saveHintsAsDefaults) {
        await getProfileRepository().update(ownerId, {
          ...(parsed.data.hints.position ? { primaryPosition: parsed.data.hints.position } : {}),
          ...(parsed.data.hints.indicatorColor !== undefined
            ? { defaultIndicatorColor: parsed.data.hints.indicatorColor }
            : {}),
          ...(parsed.data.hints.teamSide ? { defaultTeamSide: parsed.data.hints.teamSide } : {}),
        });
      }
    }

    if (parsed.data.requestAdditionalExtraction && rec.additionalExtractionAttempts < 1) {
      const result = await getControlledPlayerIdentifier().identify({
        uploadId,
        ownerId,
        gameContext: upload.context.gameContext,
        playerContext: {
          ...upload.context.playerContext,
          ...parsed.data.hints,
        },
        mediaMetadata: upload.trustedMedia!,
        fixtureScenario: "jersey_number_conflict",
      });
      // Clear prior frames.
      for (const f of await repo.listFrames(rec.identificationId)) {
        await deleteFrameObject(f.storageObjectKey).catch(() => undefined);
        await repo.markFrameDeleted(f.frameId);
      }
      const { frames, candidates } = await persistCandidatesAndFrames(upload, next, result);
      next = await repo.updateIdentification(rec.identificationId, {
        additionalExtractionAttempts: rec.additionalExtractionAttempts + 1,
        uncertainties: result.uncertainties,
        confidence: result.confidence,
        status: "confirmation_required",
      });
      return toPublic(next, frames, candidates, upload);
    }

    // No more attempts — unresolved, do not guess.
    assertIdentificationTransition("confirmation_required", "unresolved");
    next = await repo.updateIdentification(rec.identificationId, {
      status: "unresolved",
      uncertainties: [
        ...rec.uncertainties,
        "User indicated none of the candidates were correct; identity left unresolved.",
      ],
      errorCode: "PLAYER_IDENTITY_UNCONFIRMED",
      errorMessage: "Controlled player could not be confirmed.",
    });
    logEvent("identification_failed", {
      uploadId,
      identificationId: rec.identificationId,
      state: "unresolved",
      errorCode: "PLAYER_IDENTITY_UNCONFIRMED",
    });
    const frames = await repo.listFrames(rec.identificationId);
    const candidates = await repo.listCandidates(rec.identificationId);
    return toPublic(next, frames, candidates, upload);
  });
}

export async function openOwnedFrameStream(
  ownerId: string,
  uploadId: string,
  frameId: string,
): Promise<{
  stream: NodeJS.ReadableStream;
  mimeType: string;
  byteSize: number;
}> {
  const upload = await getUploadRepository().get(uploadId);
  if (!upload) throw new IdentificationServiceError(404, "UPLOAD_NOT_FOUND", "Upload not found.");
  if (upload.ownerId !== ownerId) {
    logEvent("frame_access_denied", { uploadId, reason: "forbidden" });
    throw new IdentificationServiceError(403, "FORBIDDEN", "You don't have access to this upload.");
  }
  if (upload.uploadStatus === "deleted" || upload.uploadStatus === "expired") {
    throw new IdentificationServiceError(410, "UPLOAD_EXPIRED", "This upload has expired.");
  }

  const frame = await getIdentificationRepository().getFrame(frameId);
  if (!frame || frame.uploadId !== uploadId || frame.deletedAt) {
    throw new IdentificationServiceError(404, "PLAYER_FRAME_NOT_FOUND", "Frame not found.");
  }
  if (new Date(frame.expiresAt).getTime() <= Date.now()) {
    throw new IdentificationServiceError(410, "PLAYER_CANDIDATE_EXPIRED", "Frame expired.");
  }

  // Never expose storageObjectKey to callers.
  const stream = await openFrameReadStream(frame.storageObjectKey);
  return { stream, mimeType: frame.mimeType, byteSize: frame.byteSize };
}
