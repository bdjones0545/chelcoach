/**
 * Deterministic idempotency keys + request fingerprints.
 */
import { createHash } from "node:crypto";
import type {
  EffectivePlayerContext,
  GameContext,
  MediaClassification,
  RequestedCapabilities,
} from "../scottyContract";
import { SCOTTY_CONTRACT_VERSION } from "../scottyContract";

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

export function hashCanonical(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

export function buildIdempotencyKey(input: {
  uploadId: string;
  effectivePlayer: EffectivePlayerContext;
  capabilities: RequestedCapabilities;
  contractVersion?: string;
}): string {
  const major = (input.contractVersion ?? SCOTTY_CONTRACT_VERSION).split(".")[0] ?? "1";
  const material = {
    uploadId: input.uploadId,
    effectivePlayerVersion: {
      identificationId: input.effectivePlayer.identificationId,
      confirmationId: input.effectivePlayer.confirmationId ?? null,
      source: input.effectivePlayer.source,
      position: input.effectivePlayer.position,
      jerseyNumber: input.effectivePlayer.jerseyNumber,
      indicatorColor: input.effectivePlayer.indicatorColor,
      teamSide: input.effectivePlayer.teamSide,
      userConfirmed: input.effectivePlayer.userConfirmed,
    },
    capabilities: input.capabilities,
    contractMajor: major,
  };
  return `idem_${hashCanonical(material).slice(0, 40)}`;
}

export function buildRequestFingerprint(input: {
  uploadId: string;
  gameContext: GameContext;
  effectivePlayer: EffectivePlayerContext;
  capabilities: RequestedCapabilities;
  mediaClassification: MediaClassification;
  contractVersion?: string;
}): string {
  // Explicitly excludes timestamps, signed URLs, storage secrets, tokens.
  return hashCanonical({
    uploadId: input.uploadId,
    gameContext: input.gameContext,
    effectivePlayer: input.effectivePlayer,
    capabilities: input.capabilities,
    mediaClassification: input.mediaClassification,
    contractVersion: input.contractVersion ?? SCOTTY_CONTRACT_VERSION,
  });
}

export function hashForLogs(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}
