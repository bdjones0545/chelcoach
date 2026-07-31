/**
 * Provider-independent analysis submission service (Steps 4–6).
 * Durable application job is created before the provider call.
 */
import {
  DEFAULT_REQUESTED_CAPABILITIES,
  applicationAnalysisSubmissionResultSchema,
  analysisSubmitRequestSchema,
  isGameAcceptableForUpload,
  scottyAnalysisSubmissionSchema,
  scottyProviderJobReceiptSchema,
  validatePlatformControlCombination,
  type ApplicationAnalysisSubmissionResult,
  type RequestedCapabilities,
  type ScottyErrorCode,
} from "../scottyContract";
import { getIdentificationRepository, newId } from "../identification/repository";
import { getUploadRepository } from "../uploads/repository";
import {
  EffectivePlayerResolutionError,
  resolveEffectivePlayerContext,
} from "./effectivePlayer";
import { ProviderError } from "./errors";
import { getScottyProvider } from "./factory";
import {
  buildIdempotencyKey,
  buildRequestFingerprint,
  hashForLogs,
} from "./idempotency";
import { getAnalysisJobRepository } from "./jobs/jobRepository";
import { getDefaultProviderMode } from "./jobs/syncService";
import { newApplicationRequestId } from "./submissionRepository";

export class AnalysisSubmissionError extends Error {
  constructor(
    public httpStatus: number,
    public code: ScottyErrorCode | "INVALID_REQUEST",
    message: string,
  ) {
    super(message);
    this.name = "AnalysisSubmissionError";
  }
}

function logEvent(event: string, fields: Record<string, string | number | boolean | undefined>): void {
  const parts = Object.entries(fields)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${v}`);
  console.log(`[chelcoach-analysis] event=${event} ${parts.join(" ")}`);
}

async function withLease<T>(uploadId: string, fn: () => Promise<T>): Promise<T> {
  const repo = getIdentificationRepository();
  const leaseId = newId();
  const now = new Date();
  try {
    await repo.acquireLease({
      leaseId,
      uploadId,
      analysisJobId: `submit-${leaseId}`,
      acquiredAt: now.toISOString(),
      heartbeatAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 60_000).toISOString(),
      status: "active",
    });
  } catch (err) {
    if ((err as { code?: string }).code === "PROCESSING_LEASE_CONFLICT") {
      throw new AnalysisSubmissionError(
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

export async function submitAnalysis(input: {
  ownerId: string;
  uploadId: string;
  body: unknown;
}): Promise<ApplicationAnalysisSubmissionResult> {
  const parsed = analysisSubmitRequestSchema.safeParse(input.body ?? {});
  if (!parsed.success) {
    throw new AnalysisSubmissionError(400, "INVALID_REQUEST", "Invalid analysis submission.");
  }

  const capabilities: RequestedCapabilities = DEFAULT_REQUESTED_CAPABILITIES;
  void parsed.data.capabilities;

  const upload = await getUploadRepository().get(input.uploadId);
  if (!upload) throw new AnalysisSubmissionError(404, "UPLOAD_NOT_FOUND", "Upload not found.");
  if (upload.ownerId !== input.ownerId) {
    throw new AnalysisSubmissionError(403, "FORBIDDEN", "You don't have access to this upload.");
  }
  if (upload.uploadStatus === "deleted") {
    throw new AnalysisSubmissionError(410, "MEDIA_ALREADY_DELETED", "Source media has been deleted.");
  }
  if (upload.uploadStatus === "expired" || new Date(upload.expiresAt).getTime() <= Date.now()) {
    throw new AnalysisSubmissionError(410, "UPLOAD_EXPIRED", "This upload has expired.");
  }
  if (upload.uploadStatus !== "ready") {
    throw new AnalysisSubmissionError(409, "UPLOAD_NOT_READY", "This upload is not ready.");
  }
  if (!upload.trustedMedia) {
    throw new AnalysisSubmissionError(409, "UPLOAD_NOT_READY", "Trusted media metadata missing.");
  }
  if (!isGameAcceptableForUpload(upload.context.gameContext.supportStatus)) {
    throw new AnalysisSubmissionError(422, "UNSUPPORTED_GAME", "This game is not supported.");
  }
  const combo = validatePlatformControlCombination(upload.context.playerContext);
  if (!combo.ok) {
    throw new AnalysisSubmissionError(422, combo.code, combo.message);
  }

  const identification = await getIdentificationRepository().getByUploadId(input.uploadId);
  if (!identification) {
    throw new AnalysisSubmissionError(
      409,
      "PLAYER_IDENTITY_UNCONFIRMED",
      "Confirm which player you controlled before continuing.",
    );
  }

  let effectivePlayer;
  try {
    const confirmation = identification.confirmationId
      ? await getIdentificationRepository().getConfirmation(identification.confirmationId)
      : null;
    effectivePlayer = resolveEffectivePlayerContext({
      uploadContext: upload.context,
      identification,
      confirmation,
    });
  } catch (err) {
    if (err instanceof EffectivePlayerResolutionError) {
      throw new AnalysisSubmissionError(409, err.code, err.message);
    }
    throw err;
  }

  logEvent("submission_validation_started", {
    uploadId: input.uploadId,
    ownerId: input.ownerId,
    identificationStatus: identification.status,
  });

  const idempotencyKey = buildIdempotencyKey({
    uploadId: input.uploadId,
    effectivePlayer,
    capabilities,
  });
  const fingerprint = buildRequestFingerprint({
    uploadId: input.uploadId,
    gameContext: upload.context.gameContext,
    effectivePlayer,
    capabilities,
    mediaClassification: upload.mediaClassification ?? "short_clip",
  });

  const jobs = getAnalysisJobRepository();
  const existing = await jobs.getByIdempotencyKey(idempotencyKey);
  if (existing) {
    if (existing.requestFingerprint !== fingerprint) {
      logEvent("submission_rejected", {
        uploadId: input.uploadId,
        errorCode: "IDEMPOTENCY_CONFLICT",
      });
      throw new AnalysisSubmissionError(
        409,
        "IDEMPOTENCY_CONFLICT",
        "This analysis request conflicts with a previous submission.",
      );
    }
    if (existing.externalJobId && existing.acceptedAt) {
      logEvent("duplicate_submission_reused", {
        uploadId: input.uploadId,
        applicationRequestId: existing.applicationRequestId,
        idempotencyKeyHash: hashForLogs(idempotencyKey),
      });
      return applicationAnalysisSubmissionResultSchema.parse({
        applicationRequestId: existing.applicationRequestId,
        uploadId: input.uploadId,
        provider: existing.provider,
        status: existing.canonicalStatus,
        acceptedAt: existing.acceptedAt,
        reused: true,
        nextAction: "poll_later",
        pollAfterMs: 1000,
      });
    }
    // Acceptance unknown / pending — reuse same request + key.
  }

  return withLease(input.uploadId, async () => {
    const provider = getScottyProvider();
    const applicationRequestId = existing?.applicationRequestId ?? newApplicationRequestId();
    const providerMode = existing?.provider ?? provider.mode ?? getDefaultProviderMode();
    let job =
      existing ??
      (await jobs.createPendingSubmission({
        applicationRequestId,
        uploadId: input.uploadId,
        ownerId: input.ownerId,
        provider: providerMode,
        contractVersion: "1.0.0",
        idempotencyKey,
        requestFingerprint: fingerprint,
        requestedCapabilities: capabilities,
        gameContext: upload.context.gameContext,
        uploadContext: upload.context,
        effectivePlayer,
        mediaClassification: upload.mediaClassification ?? "short_clip",
      }));

    if (!existing) {
      logEvent("application_job_created", {
        uploadId: input.uploadId,
        applicationRequestId: job.applicationRequestId,
        provider: job.provider,
      });
    }

    const submission = scottyAnalysisSubmissionSchema.parse({
      requestId: job.applicationRequestId,
      idempotencyKey,
      uploadId: input.uploadId,
      ownerReference: input.ownerId,
      gameContext: upload.context.gameContext,
      playerContext: upload.context.playerContext,
      effectivePlayer,
      mediaMetadata: upload.trustedMedia!,
      mediaClassification: upload.mediaClassification ?? "short_clip",
      capabilities,
      mediaTransfer: {
        type: "gateway_pull",
        uploadReference: input.uploadId,
      },
      retentionExpiresAt: upload.expiresAt,
      createdAt: new Date().toISOString(),
    });

    // Ensure no secrets / signed URLs in durable snapshots (already true for our shape).
    if (JSON.stringify(job.uploadContext).includes("X-Amz-") || JSON.stringify(submission).includes("signedUrl")) {
      throw new AnalysisSubmissionError(500, "INVALID_REQUEST", "Refusing to persist signed URL material.");
    }

    logEvent("submission_sent", {
      uploadId: input.uploadId,
      applicationRequestId: job.applicationRequestId,
      provider: provider.mode,
      idempotencyKeyHash: hashForLogs(idempotencyKey),
      requestFingerprintHash: hashForLogs(fingerprint),
    });

    const started = Date.now();
    try {
      const rawReceipt = await provider.submitAnalysis(submission);
      const receiptResult = scottyProviderJobReceiptSchema.safeParse(rawReceipt);
      if (!receiptResult.success) {
        logEvent("provider_response_invalid", {
          uploadId: input.uploadId,
          applicationRequestId: job.applicationRequestId,
          provider: provider.mode,
          errorCode: "REPORT_VALIDATION_FAILED",
        });
        await jobs.markFailed({
          applicationRequestId: job.applicationRequestId,
          expectedVersion: job.version,
          safeErrorCode: "REPORT_VALIDATION_FAILED",
          safeErrorMessage: "The analysis provider returned an invalid response.",
          retryable: false,
          eventSource: "application",
        });
        throw new AnalysisSubmissionError(
          502,
          "REPORT_VALIDATION_FAILED",
          "The analysis provider returned an invalid response.",
        );
      }
      const receipt = receiptResult.data;
      const accepted = await jobs.markAccepted({
        applicationRequestId: job.applicationRequestId,
        expectedVersion: job.version,
        externalJobId: receipt.externalJobId,
        acceptedAt: receipt.acceptedAt,
        canonicalStatus: receipt.status,
        pollAfterMs: receipt.pollAfterMs,
      });

      logEvent("provider_acceptance_persisted", {
        uploadId: input.uploadId,
        applicationRequestId: accepted.applicationRequestId,
        externalJobId: accepted.externalJobId,
        provider: accepted.provider,
        status: accepted.canonicalStatus,
        elapsedMs: Date.now() - started,
      });

      return applicationAnalysisSubmissionResultSchema.parse({
        applicationRequestId: accepted.applicationRequestId,
        uploadId: input.uploadId,
        provider: accepted.provider,
        status: accepted.canonicalStatus,
        acceptedAt: accepted.acceptedAt!,
        reused: false,
        nextAction: "poll_later",
        pollAfterMs: receipt.pollAfterMs,
      });
    } catch (err) {
      if (err instanceof AnalysisSubmissionError) throw err;
      if (err instanceof ProviderError) {
        const uncertain =
          err.category === "timeout" ||
          err.category === "network" ||
          err.code === "ANALYSIS_TIMEOUT" ||
          err.code === "PROVIDER_UNAVAILABLE";
        if (uncertain) {
          await jobs.markAcceptanceUnknown(job.applicationRequestId, job.version).catch(() => undefined);
          logEvent("acceptance_uncertain", {
            uploadId: input.uploadId,
            applicationRequestId: job.applicationRequestId,
            provider: provider.mode,
            errorCode: err.code,
            elapsedMs: Date.now() - started,
          });
        } else {
          await jobs
            .markFailed({
              applicationRequestId: job.applicationRequestId,
              expectedVersion: job.version,
              safeErrorCode: err.code,
              safeErrorMessage: err.message,
              retryable: err.opts.retryable,
              eventSource: "application",
            })
            .catch(() => undefined);
          logEvent("submission_rejected", {
            uploadId: input.uploadId,
            applicationRequestId: job.applicationRequestId,
            provider: err.opts.provider,
            errorCode: err.code,
            elapsedMs: Date.now() - started,
          });
        }
        const status =
          err.code === "ANALYSIS_TIMEOUT"
            ? 504
            : err.code === "RATE_LIMITED"
              ? 429
              : err.code === "PROVIDER_UNAVAILABLE" || err.code === "PROVIDER_MISCONFIGURED"
                ? 503
                : err.code === "IDEMPOTENCY_CONFLICT"
                  ? 409
                  : 422;
        throw new AnalysisSubmissionError(status, err.code, err.message);
      }
      await jobs.markAcceptanceUnknown(job.applicationRequestId, job.version).catch(() => undefined);
      throw err;
    }
  });
}
