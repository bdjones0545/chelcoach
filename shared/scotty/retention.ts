/**
 * Centralized media retention policy (shared contract + calculation helpers).
 * All timestamps are UTC (ISO-8601 / Date interpreted as absolute instants).
 */
import { z } from "zod";

export const RETENTION_POLICY_VERSION = "retention-v1";

export const mediaRetentionPolicySchema = z.object({
  policyVersion: z.string().min(1).max(64),
  rawMediaRetentionHours: z.number().int().positive().max(24 * 30),
  derivedFrameRetentionHours: z.number().int().positive().max(24 * 30),
  maximumRetentionHours: z.number().int().positive().max(24 * 90),
  deleteCompletedMedia: z.boolean(),
  deleteFailedMedia: z.boolean(),
  deleteCancelledMedia: z.boolean(),
});
export type MediaRetentionPolicy = z.infer<typeof mediaRetentionPolicySchema>;

export const DEFAULT_MEDIA_RETENTION_POLICY: MediaRetentionPolicy = mediaRetentionPolicySchema.parse({
  policyVersion: RETENTION_POLICY_VERSION,
  rawMediaRetentionHours: 24,
  derivedFrameRetentionHours: 24,
  maximumRetentionHours: 48,
  deleteCompletedMedia: true,
  deleteFailedMedia: true,
  deleteCancelledMedia: true,
});

export function hoursToMs(hours: number): number {
  return hours * 60 * 60 * 1000;
}

export function calculateExpiresAt(createdAt: Date, policy: MediaRetentionPolicy): Date {
  return new Date(createdAt.getTime() + hoursToMs(policy.rawMediaRetentionHours));
}

export function calculateAbsoluteDeleteAt(createdAt: Date, policy: MediaRetentionPolicy): Date {
  return new Date(createdAt.getTime() + hoursToMs(policy.maximumRetentionHours));
}

export type RetentionDeferReason =
  | "active_processing_lease"
  | "upload_still_active"
  | "already_deleted"
  | "not_yet_expired";

export interface RetentionEvaluationInput {
  now: Date;
  createdAt: Date;
  expiresAt: Date;
  absoluteDeleteAt: Date;
  uploadStatus: string;
  /** True when a non-expired processing lease is active. */
  hasActiveLease: boolean;
  alreadyDeleted: boolean;
  jobTerminalStatus?: "completed" | "failed" | "cancelled" | "active" | "none";
  policy: MediaRetentionPolicy;
}

export interface RetentionDecision {
  eligible: boolean;
  defer: boolean;
  maximumRetentionReached: boolean;
  reason: RetentionDeferReason | "eligible" | "force_expire_stuck_job";
  expiresAt: string;
  absoluteDeleteAt: string;
}

export function evaluateRetention(input: RetentionEvaluationInput): RetentionDecision {
  const expiresAt = input.expiresAt.toISOString();
  const absoluteDeleteAt = input.absoluteDeleteAt.toISOString();
  const nowMs = input.now.getTime();

  if (input.alreadyDeleted || input.uploadStatus === "deleted") {
    return {
      eligible: false,
      defer: false,
      maximumRetentionReached: false,
      reason: "already_deleted",
      expiresAt,
      absoluteDeleteAt,
    };
  }

  const maxReached = nowMs >= input.absoluteDeleteAt.getTime();
  if (maxReached) {
    return {
      eligible: true,
      defer: false,
      maximumRetentionReached: true,
      reason: "force_expire_stuck_job",
      expiresAt,
      absoluteDeleteAt,
    };
  }

  if (input.hasActiveLease) {
    return {
      eligible: false,
      defer: true,
      maximumRetentionReached: false,
      reason: "active_processing_lease",
      expiresAt,
      absoluteDeleteAt,
    };
  }

  if (
    input.uploadStatus === "pending" ||
    input.uploadStatus === "uploading" ||
    input.uploadStatus === "processing"
  ) {
    // Still in flight before normal expiry — defer unless absolute max (handled above).
    if (nowMs < input.expiresAt.getTime()) {
      return {
        eligible: false,
        defer: true,
        maximumRetentionReached: false,
        reason: "upload_still_active",
        expiresAt,
        absoluteDeleteAt,
      };
    }
  }

  if (nowMs < input.expiresAt.getTime()) {
    return {
      eligible: false,
      defer: false,
      maximumRetentionReached: false,
      reason: "not_yet_expired",
      expiresAt,
      absoluteDeleteAt,
    };
  }

  // Past normal expiry — respect terminal-job policy flags.
  const terminal = input.jobTerminalStatus ?? "none";
  if (terminal === "completed" && !input.policy.deleteCompletedMedia) {
    return {
      eligible: false,
      defer: false,
      maximumRetentionReached: false,
      reason: "not_yet_expired",
      expiresAt,
      absoluteDeleteAt,
    };
  }
  if (terminal === "failed" && !input.policy.deleteFailedMedia) {
    return {
      eligible: false,
      defer: false,
      maximumRetentionReached: false,
      reason: "not_yet_expired",
      expiresAt,
      absoluteDeleteAt,
    };
  }
  if (terminal === "cancelled" && !input.policy.deleteCancelledMedia) {
    return {
      eligible: false,
      defer: false,
      maximumRetentionReached: false,
      reason: "not_yet_expired",
      expiresAt,
      absoluteDeleteAt,
    };
  }

  return {
    eligible: true,
    defer: false,
    maximumRetentionReached: false,
    reason: "eligible",
    expiresAt,
    absoluteDeleteAt,
  };
}
