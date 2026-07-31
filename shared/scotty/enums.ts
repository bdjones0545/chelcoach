import { z } from "zod";

export const supportedPlatformSchema = z.enum([
  "xbox_series",
  "xbox_one",
  "playstation_5",
  "playstation_4",
  "unknown",
]);
export type SupportedPlatform = z.infer<typeof supportedPlatformSchema>;

export const controlSchemeSchema = z.enum([
  "total_control",
  "skill_stick",
  "hybrid",
  "goalie",
  "unknown",
]);
export type ControlScheme = z.infer<typeof controlSchemeSchema>;

export const playerPositionSchema = z.enum(["C", "LW", "RW", "LD", "RD", "G", "unknown"]);
export type PlayerPosition = z.infer<typeof playerPositionSchema>;

/** Game modes ChelCoach prepares for — support validated separately per title. */
export const gameModeSchema = z.enum([
  "eashl",
  "world_of_chel",
  "online_versus",
  "hut",
  "offline",
  "practice",
  "unknown",
]);
export type GameMode = z.infer<typeof gameModeSchema>;

export const teamSideSchema = z.enum(["home", "away", "unknown"]);
export type TeamSide = z.infer<typeof teamSideSchema>;

export const evidenceConfidenceLabelSchema = z.enum([
  "official",
  "very_high",
  "high",
  "moderate",
  "low",
  "insufficient",
  "unverified",
  "conflicting",
]);
export type EvidenceConfidenceLabel = z.infer<typeof evidenceConfidenceLabelSchema>;

/** Production analysis providers — demo/sample reports are not a provider. */
export const analysisProviderSchema = z.enum(["fake", "direct_anthropic", "scotty"]);
export type AnalysisProvider = z.infer<typeof analysisProviderSchema>;

export const scottyJobStatusSchema = z.enum([
  "queued",
  "inspecting_input",
  "extracting_frames",
  "identifying_controlled_player",
  "awaiting_player_confirmation",
  "validating_player_identity",
  "analyzing_gameplay",
  "validating_report",
  "finalizing",
  "completed",
  "failed",
  "cancelled",
]);
export type ScottyJobStatus = z.infer<typeof scottyJobStatusSchema>;

/** Upload/storage lifecycle — distinct from analysis-job status. */
export const uploadStatusSchema = z.enum([
  "pending",
  "uploading",
  "uploaded",
  "processing",
  "ready",
  "deletion_pending",
  "deleted",
  "delete_failed",
  "expired",
]);
export type UploadStatus = z.infer<typeof uploadStatusSchema>;

export const gameSupportStatusSchema = z.enum([
  "supported",
  "legacy_supported",
  "released_not_yet_supported",
  "unknown",
  "unsupported",
]);
export type GameSupportStatus = z.infer<typeof gameSupportStatusSchema>;

export const mediaClassificationSchema = z.enum(["short_clip", "extended_clip", "full_game"]);
export type MediaClassification = z.infer<typeof mediaClassificationSchema>;

export const leaseStatusSchema = z.enum(["active", "released", "expired", "revoked"]);
export type LeaseStatus = z.infer<typeof leaseStatusSchema>;

export const storageProviderSchema = z.enum(["memory", "replit", "s3", "gcs", "other"]);
export type StorageProvider = z.infer<typeof storageProviderSchema>;

/**
 * Controlled-player identification lifecycle — distinct from upload status
 * and future Scotty analysis-job status.
 */
export const playerIdentificationStatusSchema = z.enum([
  "not_started",
  "checking",
  "identified",
  "confirmation_required",
  "confirmed",
  "failed",
  "expired",
  "unresolved",
]);
export type PlayerIdentificationStatus = z.infer<typeof playerIdentificationStatusSchema>;

/** Step-3 local providers only — never claim fixture output is Scotty. */
export const playerIdentificationProviderSchema = z.enum(["fixture", "local_simulator"]);
export type PlayerIdentificationProvider = z.infer<typeof playerIdentificationProviderSchema>;
