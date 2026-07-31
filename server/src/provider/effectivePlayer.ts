/**
 * Resolve effective controlled-player context for analysis submission.
 * Priority: user confirmation/correction → high-confidence identification → reject.
 */
import {
  confidenceLabelFromScore,
  effectivePlayerContextSchema,
  type EffectivePlayerContext,
} from "../scottyContract";
import type { PlayerConfirmationRecord, PlayerIdentificationRecord } from "../identification/types";
import type { UploadGameplayContext } from "../scottyContract";

export class EffectivePlayerResolutionError extends Error {
  constructor(
    public code: "PLAYER_IDENTITY_UNCONFIRMED",
    message: string,
  ) {
    super(message);
    this.name = "EffectivePlayerResolutionError";
  }
}

export function resolveEffectivePlayerContext(input: {
  uploadContext: UploadGameplayContext;
  identification: PlayerIdentificationRecord;
  confirmation?: PlayerConfirmationRecord | null;
}): EffectivePlayerContext {
  const { identification, confirmation } = input;

  if (
    identification.status === "confirmation_required" ||
    identification.status === "unresolved" ||
    identification.status === "failed" ||
    identification.status === "expired" ||
    identification.status === "not_started" ||
    identification.status === "checking"
  ) {
    throw new EffectivePlayerResolutionError(
      "PLAYER_IDENTITY_UNCONFIRMED",
      "Confirm which player you controlled before continuing.",
    );
  }

  // 1–2: user confirmation / correction
  if (identification.status === "confirmed" && identification.userConfirmed) {
    const corr = identification.contextCorrection;
    const conf = confirmation;
    return effectivePlayerContextSchema.parse({
      position: corr?.position ?? conf?.confirmedPosition ?? identification.predictedPosition,
      jerseyNumber:
        corr?.jerseyNumber ??
        conf?.confirmedJerseyNumber ??
        identification.predictedJerseyNumber,
      indicatorColor:
        corr?.indicatorColor ??
        conf?.confirmedIndicatorColor ??
        identification.predictedIndicatorColor,
      teamSide: corr?.teamSide ?? conf?.confirmedTeamSide ?? identification.predictedTeamSide,
      confidence: identification.confidence,
      confidenceLabel: identification.confidenceLabel,
      source: corr ? "user_correction" : "user_confirmation",
      identificationId: identification.identificationId,
      confirmationId: identification.confirmationId ?? conf?.confirmationId,
      userConfirmed: true,
    });
  }

  // 3: high-confidence identified
  if (identification.status === "identified") {
    return effectivePlayerContextSchema.parse({
      position: identification.predictedPosition,
      jerseyNumber: identification.predictedJerseyNumber,
      indicatorColor: identification.predictedIndicatorColor,
      teamSide: identification.predictedTeamSide,
      confidence: identification.confidence,
      confidenceLabel:
        identification.confidenceLabel ?? confidenceLabelFromScore(identification.confidence),
      source: "high_confidence_identification",
      identificationId: identification.identificationId,
      userConfirmed: false,
    });
  }

  throw new EffectivePlayerResolutionError(
    "PLAYER_IDENTITY_UNCONFIRMED",
    "Confirm which player you controlled before continuing.",
  );
}
