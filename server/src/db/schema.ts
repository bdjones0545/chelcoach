/**
 * Drizzle schema — ChelCoach backend.
 *
 * Legacy clip/job/analysis tables remain for the current MVP loop.
 * Scotty Step 1 adds media_uploads, processing_leases, scotty_analysis_jobs,
 * and scotty_analysis_reports — raw video bytes are NEVER stored in Postgres.
 */
import {
  bigint,
  boolean,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import type { AnalysisReport } from "../contract";
import type {
  GameContext,
  PlayerContext,
  ProcessingLease,
  ScottyReport,
  TrustedMediaMetadata,
} from "../scottyContract";

export const clipStatusEnum = pgEnum("clip_status", [
  "uploading",
  "queued",
  "extracting",
  "analyzing",
  "complete",
  "failed",
]);

export const jobStatusEnum = pgEnum("job_status", [
  "queued",
  "extracting",
  "analyzing",
  "complete",
  "failed",
]);

export const uploadStorageStatusEnum = pgEnum("upload_storage_status", [
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

export const scottyJobStatusDbEnum = pgEnum("scotty_job_status", [
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

export const leaseStatusDbEnum = pgEnum("lease_status", [
  "active",
  "released",
  "expired",
  "revoked",
]);

export const analysisProviderDbEnum = pgEnum("analysis_provider", [
  "fake",
  "direct_anthropic",
  "scotty",
]);

/** Anonymous session (no auth in v1). Real accounts arrive in a later phase. */
export const sessions = pgTable("sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

/** One uploaded gameplay clip (legacy MVP path). */
export const clips = pgTable("clips", {
  id: uuid("id").primaryKey().defaultRandom(),
  sessionId: uuid("session_id")
    .notNull()
    .references(() => sessions.id, { onDelete: "cascade" }),
  storageKey: text("storage_key").notNull(),
  filename: text("filename").notNull(),
  contentType: text("content_type").notNull(),
  sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
  durationSeconds: integer("duration_seconds"),
  status: clipStatusEnum("status").notNull().default("uploading"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

/** One analysis job per clip (legacy). */
export const analysisJobs = pgTable("analysis_jobs", {
  id: uuid("id").primaryKey().defaultRandom(),
  clipId: uuid("clip_id")
    .notNull()
    .unique()
    .references(() => clips.id, { onDelete: "cascade" }),
  status: jobStatusEnum("status").notNull().default("queued"),
  phaseProgress: integer("phase_progress").notNull().default(0),
  attempts: integer("attempts").notNull().default(0),
  errorCode: text("error_code"),
  errorMessage: text("error_message"),
  claimedAt: timestamp("claimed_at", { withTimezone: true }),
  startedAt: timestamp("started_at", { withTimezone: true }),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

/** Finished legacy report. */
export const analyses = pgTable("analyses", {
  id: uuid("id").primaryKey().defaultRandom(),
  clipId: uuid("clip_id")
    .notNull()
    .unique()
    .references(() => clips.id, { onDelete: "cascade" }),
  report: jsonb("report").$type<AnalysisReport>().notNull(),
  model: text("model"),
  tokensIn: integer("tokens_in"),
  tokensOut: integer("tokens_out"),
  costCents: integer("cost_cents"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

/** Reusable gameplay preferences per pseudonymous owner (Step 2). */
export const gameplayProfiles = pgTable("gameplay_profiles", {
  userId: text("user_id").primaryKey(),
  preferredPlatform: text("preferred_platform").notNull(),
  consoleGeneration: text("console_generation"),
  preferredControlScheme: text("preferred_control_scheme").notNull(),
  primaryPosition: text("primary_position").notNull(),
  commonGameMode: text("common_game_mode").notNull(),
  defaultIndicatorColor: text("default_indicator_color"),
  defaultTeamSide: text("default_team_side"),
  lastSelectedGameId: text("last_selected_game_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

/**
 * Scotty-era upload record — ownership + storage refs + retention state only.
 * No raw video bytes / base64 columns.
 */
export const mediaUploads = pgTable("media_uploads", {
  id: uuid("id").primaryKey().defaultRandom(),
  ownerId: text("owner_id").notNull(),
  storageProvider: text("storage_provider").notNull(),
  storageObjectKey: text("storage_object_key"),
  originalFilename: text("original_filename").notNull(),
  displayFilename: text("display_filename").notNull(),
  mimeType: text("mime_type").notNull(),
  byteSize: bigint("byte_size", { mode: "number" }).notNull(),
  clientDeclaredDurationSec: integer("client_declared_duration_sec"),
  trustedMedia: jsonb("trusted_media").$type<TrustedMediaMetadata>(),
  mediaClassification: text("media_classification"),
  /** Immutable per-upload gameplay context snapshot. */
  gameplayContext: jsonb("gameplay_context"),
  uploadStatus: uploadStorageStatusEnum("upload_status").notNull().default("pending"),
  checksumSha256: text("checksum_sha256"),
  retentionPolicyVersion: text("retention_policy_version").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  absoluteDeleteAt: timestamp("absolute_delete_at", { withTimezone: true }).notNull(),
  pendingExpiresAt: timestamp("pending_expires_at", { withTimezone: true }),
  uploadedAt: timestamp("uploaded_at", { withTimezone: true }),
  readyAt: timestamp("ready_at", { withTimezone: true }),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  deletionAttemptCount: integer("deletion_attempt_count").notNull().default(0),
  lastDeletionErrorCode: text("last_deletion_error_code"),
  errorCode: text("error_code"),
  errorMessage: text("error_message"),
  earlyDeletionRequestedAt: timestamp("early_deletion_requested_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

/** Processing lease — durable, heartbeat-based; cleanup inspects this, not in-memory flags. */
export const processingLeases = pgTable("processing_leases", {
  id: uuid("id").primaryKey().defaultRandom(),
  uploadId: uuid("upload_id")
    .notNull()
    .references(() => mediaUploads.id, { onDelete: "cascade" }),
  analysisJobId: uuid("analysis_job_id").notNull(),
  status: leaseStatusDbEnum("status").notNull().default("active"),
  acquiredAt: timestamp("acquired_at", { withTimezone: true }).notNull(),
  heartbeatAt: timestamp("heartbeat_at", { withTimezone: true }).notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  releasedAt: timestamp("released_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

/** Scotty analysis job — no video payload. */
export const scottyAnalysisJobs = pgTable("scotty_analysis_jobs", {
  id: uuid("id").primaryKey().defaultRandom(),
  uploadId: uuid("upload_id")
    .notNull()
    .references(() => mediaUploads.id, { onDelete: "restrict" }),
  provider: analysisProviderDbEnum("provider").notNull(),
  externalScottyJobId: text("external_scotty_job_id"),
  idempotencyKey: text("idempotency_key").notNull().unique(),
  status: scottyJobStatusDbEnum("status").notNull().default("queued"),
  contractVersion: text("contract_version").notNull(),
  playerContext: jsonb("player_context").$type<PlayerContext>(),
  gameContext: jsonb("game_context").$type<GameContext>(),
  errorCode: text("error_code"),
  errorMessage: text("error_message"),
  phaseProgress: integer("phase_progress").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
});

/** Validated Scotty report JSON — retained after source media deletion. */
export const scottyAnalysisReports = pgTable("scotty_analysis_reports", {
  id: uuid("id").primaryKey().defaultRandom(),
  jobId: uuid("job_id")
    .notNull()
    .unique()
    .references(() => scottyAnalysisJobs.id, { onDelete: "cascade" }),
  uploadId: uuid("upload_id")
    .notNull()
    .references(() => mediaUploads.id, { onDelete: "restrict" }),
  report: jsonb("report").$type<ScottyReport>().notNull(),
  reportVersion: text("report_version").notNull(),
  rubricVersion: text("rubric_version").notNull(),
  contractVersion: text("contract_version").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

/**
 * Controlled-player identification (Step 3) — separate from upload/job status.
 * No frame binaries here. Full record mirrored in `record` jsonb for flexibility.
 */
export const playerIdentifications = pgTable("player_identifications", {
  id: uuid("id").primaryKey().defaultRandom(),
  uploadId: uuid("upload_id")
    .notNull()
    .unique()
    .references(() => mediaUploads.id, { onDelete: "cascade" }),
  ownerId: text("owner_id").notNull(),
  analysisJobId: uuid("analysis_job_id"),
  contractVersion: text("contract_version").notNull(),
  status: text("status").notNull(),
  detected: boolean("detected").notNull().default(false),
  userConfirmed: boolean("user_confirmed").notNull().default(false),
  confirmationId: uuid("confirmation_id"),
  provider: text("provider").notNull(),
  record: jsonb("record").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

/** Confirmation frame metadata only — bytes live in object storage. */
export const confirmationFrames = pgTable("confirmation_frames", {
  id: uuid("id").primaryKey().defaultRandom(),
  uploadId: uuid("upload_id")
    .notNull()
    .references(() => mediaUploads.id, { onDelete: "cascade" }),
  identificationId: uuid("identification_id")
    .notNull()
    .references(() => playerIdentifications.id, { onDelete: "cascade" }),
  ownerId: text("owner_id").notNull(),
  storageObjectKey: text("storage_object_key").notNull(),
  timestampSec: integer("timestamp_sec").notNull(),
  mimeType: text("mime_type").notNull(),
  width: integer("width").notNull(),
  height: integer("height").notNull(),
  byteSize: integer("byte_size").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

/** Bounded candidate skaters for confirmation UI. */
export const playerCandidates = pgTable("player_candidates", {
  id: uuid("id").primaryKey().defaultRandom(),
  uploadId: uuid("upload_id")
    .notNull()
    .references(() => mediaUploads.id, { onDelete: "cascade" }),
  identificationId: uuid("identification_id")
    .notNull()
    .references(() => playerIdentifications.id, { onDelete: "cascade" }),
  representativeFrameId: uuid("representative_frame_id")
    .notNull()
    .references(() => confirmationFrames.id, { onDelete: "cascade" }),
  payload: jsonb("payload").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

/** User confirmation of controlled skater. */
export const playerConfirmations = pgTable("player_confirmations", {
  id: uuid("id").primaryKey().defaultRandom(),
  identificationId: uuid("identification_id")
    .notNull()
    .references(() => playerIdentifications.id, { onDelete: "cascade" }),
  uploadId: uuid("upload_id")
    .notNull()
    .references(() => mediaUploads.id, { onDelete: "cascade" }),
  ownerId: text("owner_id").notNull(),
  selectedCandidateId: uuid("selected_candidate_id").notNull(),
  selectedFrameId: uuid("selected_frame_id").notNull(),
  payload: jsonb("payload").notNull(),
  confirmedAt: timestamp("confirmed_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

/** Optional advisory cleanup lock table for multi-instance safety later. */
export const mediaCleanupLocks = pgTable("media_cleanup_locks", {
  uploadId: uuid("upload_id")
    .primaryKey()
    .references(() => mediaUploads.id, { onDelete: "cascade" }),
  owner: text("owner").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  acquiredAt: timestamp("acquired_at", { withTimezone: true }).notNull(),
  active: boolean("active").notNull().default(true),
});

export type ClipRow = typeof clips.$inferSelect;
export type AnalysisJobRow = typeof analysisJobs.$inferSelect;
export type AnalysisRow = typeof analyses.$inferSelect;
export type MediaUploadRow = typeof mediaUploads.$inferSelect;
export type ProcessingLeaseRow = typeof processingLeases.$inferSelect;
export type ScottyAnalysisJobRow = typeof scottyAnalysisJobs.$inferSelect;
export type ScottyAnalysisReportRow = typeof scottyAnalysisReports.$inferSelect;

/** Compile-time guard: lease JSON shape stays aligned with the shared contract. */
export type _LeaseShapeCheck = ProcessingLease;
