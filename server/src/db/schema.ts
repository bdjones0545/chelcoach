/**
 * Drizzle schema — ChelCoach backend.
 *
 * Legacy clip/job/analysis tables remain for the current MVP loop.
 * Scotty tables: media_uploads, processing_leases, analysis jobs/events/reports,
 * simulator jobs, callback dedupe — raw video bytes are NEVER stored in Postgres.
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
  uniqueIndex,
  uuid,
  index,
} from "drizzle-orm/pg-core";
import type { AnalysisReport } from "../contract";
import type {
  EffectivePlayerContext,
  GameContext,
  MediaClassification,
  PlayerContext,
  ProcessingLease,
  RequestedCapabilities,
  ScottyReport,
  TrustedMediaMetadata,
  UploadGameplayContext,
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
  "simulator",
  "direct_anthropic",
  "scotty",
]);

export const submissionAcceptanceStateDbEnum = pgEnum("submission_acceptance_state", [
  "pending",
  "accepted",
  "acceptance_unknown",
  "rejected",
]);

export const jobEventSourceDbEnum = pgEnum("job_event_source", [
  "application",
  "provider_poll",
  "provider_callback",
  "user_confirmation",
  "user_cancellation",
  "reconciliation",
  "system",
]);

export const callbackProcessingStatusDbEnum = pgEnum("callback_processing_status", [
  "received",
  "processed",
  "ignored_stale",
  "rejected_conflict",
  "failed",
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

/**
 * Canonical ChelCoach analysis job — application system of record (Step 6).
 * Provider execution state is separate; this row owns ownership + lifecycle.
 */
export const scottyAnalysisJobs = pgTable(
  "scotty_analysis_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    applicationRequestId: text("application_request_id").notNull(),
    uploadId: uuid("upload_id")
      .notNull()
      .references(() => mediaUploads.id, { onDelete: "restrict" }),
    ownerId: text("owner_id").notNull(),
    provider: analysisProviderDbEnum("provider").notNull(),
    externalJobId: text("external_job_id"),
    contractVersion: text("contract_version").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    requestFingerprint: text("request_fingerprint").notNull(),
    requestedCapabilities: jsonb("requested_capabilities").$type<RequestedCapabilities>().notNull(),
    gameContext: jsonb("game_context").$type<GameContext>().notNull(),
    uploadContext: jsonb("upload_context").$type<UploadGameplayContext>().notNull(),
    effectivePlayer: jsonb("effective_player").$type<EffectivePlayerContext>().notNull(),
    mediaClassification: text("media_classification").$type<MediaClassification>().notNull(),
    canonicalStatus: scottyJobStatusDbEnum("canonical_status").notNull().default("queued"),
    providerStatus: scottyJobStatusDbEnum("provider_status"),
    statusSequenceNumber: integer("status_sequence_number").notNull().default(1),
    providerSequenceNumber: integer("provider_sequence_number"),
    submissionAcceptanceState: submissionAcceptanceStateDbEnum("submission_acceptance_state")
      .notNull()
      .default("pending"),
    confirmationRequired: boolean("confirmation_required").notNull().default(false),
    cancellationRequested: boolean("cancellation_requested").notNull().default(false),
    cancellationRequestedAt: timestamp("cancellation_requested_at", { withTimezone: true }),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    failedAt: timestamp("failed_at", { withTimezone: true }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    lastSynchronizedAt: timestamp("last_synchronized_at", { withTimezone: true }),
    nextSyncAfter: timestamp("next_sync_after", { withTimezone: true }),
    reconciliationRequired: boolean("reconciliation_required").notNull().default(false),
    safeErrorCode: text("safe_error_code"),
    safeErrorMessage: text("safe_error_message"),
    retryable: boolean("retryable").notNull().default(false),
    reportId: uuid("report_id"),
    reportAvailable: boolean("report_available").notNull().default(false),
    version: integer("version").notNull().default(1),
    submissionAttemptCount: integer("submission_attempt_count").notNull().default(0),
    syncAttemptCount: integer("sync_attempt_count").notNull().default(0),
    reportFetchAttemptCount: integer("report_fetch_attempt_count").notNull().default(0),
    cancellationAttemptCount: integer("cancellation_attempt_count").notNull().default(0),
    confirmationAttemptCount: integer("confirmation_attempt_count").notNull().default(0),
    reconciliationAttemptCount: integer("reconciliation_attempt_count").notNull().default(0),
    lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
    nextRetryAt: timestamp("next_retry_at", { withTimezone: true }),
    selectedRemoteCandidateId: text("selected_remote_candidate_id"),
    remoteConfirmationAt: timestamp("remote_confirmation_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    appRequestUnique: uniqueIndex("scotty_jobs_application_request_id_uidx").on(t.applicationRequestId),
    idempotencyUnique: uniqueIndex("scotty_jobs_idempotency_key_uidx").on(t.idempotencyKey),
    providerExternalUnique: uniqueIndex("scotty_jobs_provider_external_uidx").on(
      t.provider,
      t.externalJobId,
    ),
    ownerRequestIdx: index("scotty_jobs_owner_request_idx").on(t.ownerId, t.applicationRequestId),
    uploadIdx: index("scotty_jobs_upload_id_idx").on(t.uploadId),
    statusSyncIdx: index("scotty_jobs_status_next_sync_idx").on(t.canonicalStatus, t.nextSyncAfter),
    reconIdx: index("scotty_jobs_recon_updated_idx").on(t.reconciliationRequired, t.updatedAt),
    reportIdx: index("scotty_jobs_report_id_idx").on(t.reportId),
  }),
);

/** Append-only status history — never mutate rows. */
export const scottyAnalysisJobEvents = pgTable(
  "scotty_analysis_job_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    applicationRequestId: text("application_request_id").notNull(),
    uploadId: uuid("upload_id")
      .notNull()
      .references(() => mediaUploads.id, { onDelete: "restrict" }),
    ownerId: text("owner_id").notNull(),
    jobId: uuid("job_id")
      .notNull()
      .references(() => scottyAnalysisJobs.id, { onDelete: "cascade" }),
    eventType: text("event_type").notNull(),
    canonicalStatus: scottyJobStatusDbEnum("canonical_status").notNull(),
    previousStatus: scottyJobStatusDbEnum("previous_status"),
    sequenceNumber: integer("sequence_number").notNull(),
    providerSequenceNumber: integer("provider_sequence_number"),
    eventSource: jobEventSourceDbEnum("event_source").notNull(),
    safeMessage: text("safe_message"),
    safeErrorCode: text("safe_error_code"),
    metadata: jsonb("metadata").$type<Record<string, string | number | boolean | null>>(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    jobSeqIdx: index("scotty_job_events_job_seq_idx").on(t.jobId, t.sequenceNumber),
    requestIdx: index("scotty_job_events_request_idx").on(t.applicationRequestId),
  }),
);

/** Validated Scotty report JSON — retained after source media deletion. */
export const scottyAnalysisReports = pgTable(
  "scotty_analysis_reports",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    applicationRequestId: text("application_request_id").notNull(),
    jobId: uuid("job_id")
      .notNull()
      .unique()
      .references(() => scottyAnalysisJobs.id, { onDelete: "cascade" }),
    externalJobId: text("external_job_id").notNull(),
    uploadId: uuid("upload_id")
      .notNull()
      .references(() => mediaUploads.id, { onDelete: "restrict" }),
    ownerId: text("owner_id").notNull(),
    provider: analysisProviderDbEnum("provider").notNull(),
    contractVersion: text("contract_version").notNull(),
    reportVersion: text("report_version").notNull(),
    rubricVersion: text("rubric_version").notNull(),
    strategyKnowledgeVersion: text("strategy_knowledge_version").notNull(),
    controlKnowledgeVersion: text("control_knowledge_version").notNull(),
    report: jsonb("report").$type<ScottyReport>().notNull(),
    contentChecksum: text("content_checksum").notNull(),
    schemaValidatedAt: timestamp("schema_validated_at", { withTimezone: true }).notNull(),
    providerGeneratedAt: timestamp("provider_generated_at", { withTimezone: true }).notNull(),
    persistedAt: timestamp("persisted_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    requestUnique: uniqueIndex("scotty_reports_application_request_uidx").on(t.applicationRequestId),
    uploadIdx: index("scotty_reports_upload_id_idx").on(t.uploadId),
  }),
);

/**
 * Durable simulator execution state (Step 6) — recreate deterministic lifecycle after restart.
 * Isolated from production-facing application fields.
 */
export const scottySimulatorJobs = pgTable(
  "scotty_simulator_jobs",
  {
    externalJobId: text("external_job_id").primaryKey(),
    applicationRequestId: text("application_request_id").notNull(),
    uploadId: text("upload_id").notNull(),
    ownerReference: text("owner_reference").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    requestFingerprint: text("request_fingerprint").notNull(),
    contractVersion: text("contract_version").notNull(),
    scenario: text("scenario").notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }).notNull(),
    submission: jsonb("submission").notNull(),
    effectivePlayer: jsonb("effective_player").$type<EffectivePlayerContext>().notNull(),
    capabilities: jsonb("capabilities").$type<RequestedCapabilities>().notNull(),
    mediaClassification: text("media_classification").notNull(),
    mediaDurationSec: integer("media_duration_sec").notNull(),
    confirmationRequired: boolean("confirmation_required").notNull().default(false),
    confirmationReceivedAt: timestamp("confirmation_received_at", { withTimezone: true }),
    selectedCandidateId: text("selected_candidate_id"),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    cancelReason: text("cancel_reason"),
    failurePoint: text("failure_point"),
    terminalStatus: text("terminal_status"),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    report: jsonb("report").$type<ScottyReport>(),
    reportFixtureId: text("report_fixture_id"),
    lastSequenceNumber: integer("last_sequence_number").notNull().default(1),
    timingsProfile: jsonb("timings_profile"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    idempotencyUnique: uniqueIndex("scotty_sim_jobs_idempotency_uidx").on(t.idempotencyKey),
    requestIdx: index("scotty_sim_jobs_request_idx").on(t.applicationRequestId),
  }),
);

/** Callback event deduplication foundation — processing remains disabled. */
export const scottyCallbackEvents = pgTable(
  "scotty_callback_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    eventId: text("event_id").notNull(),
    provider: analysisProviderDbEnum("provider").notNull(),
    externalJobId: text("external_job_id").notNull(),
    applicationRequestId: text("application_request_id"),
    sequenceNumber: integer("sequence_number").notNull(),
    status: scottyJobStatusDbEnum("status"),
    processingStatus: callbackProcessingStatusDbEnum("processing_status").notNull().default("received"),
    safeErrorCode: text("safe_error_code"),
    receivedAt: timestamp("received_at", { withTimezone: true }).defaultNow().notNull(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
  },
  (t) => ({
    eventUnique: uniqueIndex("scotty_callback_event_id_uidx").on(t.provider, t.eventId),
    jobSeqIdx: index("scotty_callback_job_seq_idx").on(t.provider, t.externalJobId, t.sequenceNumber),
  }),
);

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
export type ScottyAnalysisJobEventRow = typeof scottyAnalysisJobEvents.$inferSelect;
export type ScottySimulatorJobRow = typeof scottySimulatorJobs.$inferSelect;
export type ScottyCallbackEventRow = typeof scottyCallbackEvents.$inferSelect;

/** Compile-time guard: lease JSON shape stays aligned with the shared contract. */
export type _LeaseShapeCheck = ProcessingLease;
export type _PlayerContextCheck = PlayerContext;
