/**
 * Centralized retention-policy loader.
 * Env-driven; never hardcode retention hours at call sites.
 */
import {
  DEFAULT_MEDIA_RETENTION_POLICY,
  mediaRetentionPolicySchema,
  type MediaRetentionPolicy,
  RETENTION_POLICY_VERSION,
  SCOTTY_DEFAULT_MAX_UPLOAD_BYTES,
} from "../scottyContract";

function intEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min || n > max) {
    throw new Error(`[chelcoach-api] Invalid ${name}=${raw} (expected ${min}–${max}).`);
  }
  return Math.floor(n);
}

let cached: MediaRetentionPolicy | null = null;

/** Load retention policy from env (defaults: 24h raw / 48h absolute max). */
export function getMediaRetentionPolicy(): MediaRetentionPolicy {
  if (cached) return cached;
  const rawHours = intEnv("CHELCOACH_RAW_MEDIA_RETENTION_HOURS", 24, 1, 24 * 30);
  const maxHours = intEnv("CHELCOACH_RAW_MEDIA_MAX_RETENTION_HOURS", 48, 1, 24 * 90);
  if (maxHours < rawHours) {
    throw new Error(
      `[chelcoach-api] CHELCOACH_RAW_MEDIA_MAX_RETENTION_HOURS (${maxHours}) must be >= CHELCOACH_RAW_MEDIA_RETENTION_HOURS (${rawHours}).`,
    );
  }
  cached = mediaRetentionPolicySchema.parse({
    ...DEFAULT_MEDIA_RETENTION_POLICY,
    policyVersion: RETENTION_POLICY_VERSION,
    rawMediaRetentionHours: rawHours,
    derivedFrameRetentionHours: rawHours,
    maximumRetentionHours: maxHours,
  });
  return cached;
}

export function resetRetentionPolicyCacheForTests(): void {
  cached = null;
}

/** Configurable upload byte cap — defaults to shared SCOTTY_DEFAULT_MAX_UPLOAD_BYTES (2 GB). */
export function getMaxUploadBytes(): number {
  return intEnv("CHELCOACH_MAX_UPLOAD_BYTES", SCOTTY_DEFAULT_MAX_UPLOAD_BYTES, 1_000_000, 10 * 1024 ** 3);
}

/** Pending/abandoned upload expiration (hours). */
export function getPendingUploadExpirationHours(): number {
  return intEnv("CHELCOACH_PENDING_UPLOAD_EXPIRATION_HOURS", 2, 1, 72);
}

export function retentionNoticeText(hours = getMediaRetentionPolicy().rawMediaRetentionHours): string {
  return `Uploaded gameplay video is automatically deleted after ${hours} hours. Your completed coaching report can remain available.`;
}
