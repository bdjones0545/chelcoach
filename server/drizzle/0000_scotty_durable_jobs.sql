CREATE TYPE "public"."analysis_provider" AS ENUM('fake', 'simulator', 'direct_anthropic', 'scotty');--> statement-breakpoint
CREATE TYPE "public"."callback_processing_status" AS ENUM('received', 'processed', 'ignored_stale', 'rejected_conflict', 'failed');--> statement-breakpoint
CREATE TYPE "public"."clip_status" AS ENUM('uploading', 'queued', 'extracting', 'analyzing', 'complete', 'failed');--> statement-breakpoint
CREATE TYPE "public"."job_event_source" AS ENUM('application', 'provider_poll', 'provider_callback', 'user_confirmation', 'user_cancellation', 'reconciliation', 'system');--> statement-breakpoint
CREATE TYPE "public"."job_status" AS ENUM('queued', 'extracting', 'analyzing', 'complete', 'failed');--> statement-breakpoint
CREATE TYPE "public"."lease_status" AS ENUM('active', 'released', 'expired', 'revoked');--> statement-breakpoint
CREATE TYPE "public"."scotty_job_status" AS ENUM('queued', 'inspecting_input', 'extracting_frames', 'identifying_controlled_player', 'awaiting_player_confirmation', 'validating_player_identity', 'analyzing_gameplay', 'validating_report', 'finalizing', 'completed', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."submission_acceptance_state" AS ENUM('pending', 'accepted', 'acceptance_unknown', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."upload_storage_status" AS ENUM('pending', 'uploading', 'uploaded', 'processing', 'ready', 'deletion_pending', 'deleted', 'delete_failed', 'expired');--> statement-breakpoint
CREATE TABLE "analyses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clip_id" uuid NOT NULL,
	"report" jsonb NOT NULL,
	"model" text,
	"tokens_in" integer,
	"tokens_out" integer,
	"cost_cents" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "analyses_clip_id_unique" UNIQUE("clip_id")
);
--> statement-breakpoint
CREATE TABLE "analysis_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clip_id" uuid NOT NULL,
	"status" "job_status" DEFAULT 'queued' NOT NULL,
	"phase_progress" integer DEFAULT 0 NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"error_code" text,
	"error_message" text,
	"claimed_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "analysis_jobs_clip_id_unique" UNIQUE("clip_id")
);
--> statement-breakpoint
CREATE TABLE "clips" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"storage_key" text NOT NULL,
	"filename" text NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"duration_seconds" integer,
	"status" "clip_status" DEFAULT 'uploading' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "confirmation_frames" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"upload_id" uuid NOT NULL,
	"identification_id" uuid NOT NULL,
	"owner_id" text NOT NULL,
	"storage_object_key" text NOT NULL,
	"timestamp_sec" integer NOT NULL,
	"mime_type" text NOT NULL,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"byte_size" integer NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "gameplay_profiles" (
	"user_id" text PRIMARY KEY NOT NULL,
	"preferred_platform" text NOT NULL,
	"console_generation" text,
	"preferred_control_scheme" text NOT NULL,
	"primary_position" text NOT NULL,
	"common_game_mode" text NOT NULL,
	"default_indicator_color" text,
	"default_team_side" text,
	"last_selected_game_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "media_cleanup_locks" (
	"upload_id" uuid PRIMARY KEY NOT NULL,
	"owner" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"acquired_at" timestamp with time zone NOT NULL,
	"active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "media_uploads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" text NOT NULL,
	"storage_provider" text NOT NULL,
	"storage_object_key" text,
	"original_filename" text NOT NULL,
	"display_filename" text NOT NULL,
	"mime_type" text NOT NULL,
	"byte_size" bigint NOT NULL,
	"client_declared_duration_sec" integer,
	"trusted_media" jsonb,
	"media_classification" text,
	"gameplay_context" jsonb,
	"upload_status" "upload_storage_status" DEFAULT 'pending' NOT NULL,
	"checksum_sha256" text,
	"retention_policy_version" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"absolute_delete_at" timestamp with time zone NOT NULL,
	"pending_expires_at" timestamp with time zone,
	"uploaded_at" timestamp with time zone,
	"ready_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"deletion_attempt_count" integer DEFAULT 0 NOT NULL,
	"last_deletion_error_code" text,
	"error_code" text,
	"error_message" text,
	"early_deletion_requested_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "player_candidates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"upload_id" uuid NOT NULL,
	"identification_id" uuid NOT NULL,
	"representative_frame_id" uuid NOT NULL,
	"payload" jsonb NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "player_confirmations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"identification_id" uuid NOT NULL,
	"upload_id" uuid NOT NULL,
	"owner_id" text NOT NULL,
	"selected_candidate_id" uuid NOT NULL,
	"selected_frame_id" uuid NOT NULL,
	"payload" jsonb NOT NULL,
	"confirmed_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "player_identifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"upload_id" uuid NOT NULL,
	"owner_id" text NOT NULL,
	"analysis_job_id" uuid,
	"contract_version" text NOT NULL,
	"status" text NOT NULL,
	"detected" boolean DEFAULT false NOT NULL,
	"user_confirmed" boolean DEFAULT false NOT NULL,
	"confirmation_id" uuid,
	"provider" text NOT NULL,
	"record" jsonb NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "player_identifications_upload_id_unique" UNIQUE("upload_id")
);
--> statement-breakpoint
CREATE TABLE "processing_leases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"upload_id" uuid NOT NULL,
	"analysis_job_id" uuid NOT NULL,
	"status" "lease_status" DEFAULT 'active' NOT NULL,
	"acquired_at" timestamp with time zone NOT NULL,
	"heartbeat_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"released_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scotty_analysis_job_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"application_request_id" text NOT NULL,
	"upload_id" uuid NOT NULL,
	"owner_id" text NOT NULL,
	"job_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"canonical_status" "scotty_job_status" NOT NULL,
	"previous_status" "scotty_job_status",
	"sequence_number" integer NOT NULL,
	"provider_sequence_number" integer,
	"event_source" "job_event_source" NOT NULL,
	"safe_message" text,
	"safe_error_code" text,
	"metadata" jsonb,
	"occurred_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scotty_analysis_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"application_request_id" text NOT NULL,
	"upload_id" uuid NOT NULL,
	"owner_id" text NOT NULL,
	"provider" "analysis_provider" NOT NULL,
	"external_job_id" text,
	"contract_version" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_fingerprint" text NOT NULL,
	"requested_capabilities" jsonb NOT NULL,
	"game_context" jsonb NOT NULL,
	"upload_context" jsonb NOT NULL,
	"effective_player" jsonb NOT NULL,
	"media_classification" text NOT NULL,
	"canonical_status" "scotty_job_status" DEFAULT 'queued' NOT NULL,
	"provider_status" "scotty_job_status",
	"status_sequence_number" integer DEFAULT 1 NOT NULL,
	"provider_sequence_number" integer,
	"submission_acceptance_state" "submission_acceptance_state" DEFAULT 'pending' NOT NULL,
	"confirmation_required" boolean DEFAULT false NOT NULL,
	"cancellation_requested" boolean DEFAULT false NOT NULL,
	"cancellation_requested_at" timestamp with time zone,
	"accepted_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"failed_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"last_synchronized_at" timestamp with time zone,
	"next_sync_after" timestamp with time zone,
	"reconciliation_required" boolean DEFAULT false NOT NULL,
	"safe_error_code" text,
	"safe_error_message" text,
	"retryable" boolean DEFAULT false NOT NULL,
	"report_id" uuid,
	"report_available" boolean DEFAULT false NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"submission_attempt_count" integer DEFAULT 0 NOT NULL,
	"sync_attempt_count" integer DEFAULT 0 NOT NULL,
	"report_fetch_attempt_count" integer DEFAULT 0 NOT NULL,
	"cancellation_attempt_count" integer DEFAULT 0 NOT NULL,
	"confirmation_attempt_count" integer DEFAULT 0 NOT NULL,
	"reconciliation_attempt_count" integer DEFAULT 0 NOT NULL,
	"last_attempt_at" timestamp with time zone,
	"next_retry_at" timestamp with time zone,
	"selected_remote_candidate_id" text,
	"remote_confirmation_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scotty_analysis_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"application_request_id" text NOT NULL,
	"job_id" uuid NOT NULL,
	"external_job_id" text NOT NULL,
	"upload_id" uuid NOT NULL,
	"owner_id" text NOT NULL,
	"provider" "analysis_provider" NOT NULL,
	"contract_version" text NOT NULL,
	"report_version" text NOT NULL,
	"rubric_version" text NOT NULL,
	"strategy_knowledge_version" text NOT NULL,
	"control_knowledge_version" text NOT NULL,
	"report" jsonb NOT NULL,
	"content_checksum" text NOT NULL,
	"schema_validated_at" timestamp with time zone NOT NULL,
	"provider_generated_at" timestamp with time zone NOT NULL,
	"persisted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "scotty_analysis_reports_job_id_unique" UNIQUE("job_id")
);
--> statement-breakpoint
CREATE TABLE "scotty_callback_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" text NOT NULL,
	"provider" "analysis_provider" NOT NULL,
	"external_job_id" text NOT NULL,
	"application_request_id" text,
	"sequence_number" integer NOT NULL,
	"status" "scotty_job_status",
	"processing_status" "callback_processing_status" DEFAULT 'received' NOT NULL,
	"safe_error_code" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "scotty_simulator_jobs" (
	"external_job_id" text PRIMARY KEY NOT NULL,
	"application_request_id" text NOT NULL,
	"upload_id" text NOT NULL,
	"owner_reference" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_fingerprint" text NOT NULL,
	"contract_version" text NOT NULL,
	"scenario" text NOT NULL,
	"accepted_at" timestamp with time zone NOT NULL,
	"submission" jsonb NOT NULL,
	"effective_player" jsonb NOT NULL,
	"capabilities" jsonb NOT NULL,
	"media_classification" text NOT NULL,
	"media_duration_sec" integer NOT NULL,
	"confirmation_required" boolean DEFAULT false NOT NULL,
	"confirmation_received_at" timestamp with time zone,
	"selected_candidate_id" text,
	"cancelled_at" timestamp with time zone,
	"cancel_reason" text,
	"failure_point" text,
	"terminal_status" text,
	"error_code" text,
	"error_message" text,
	"report" jsonb,
	"report_fixture_id" text,
	"last_sequence_number" integer DEFAULT 1 NOT NULL,
	"timings_profile" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "analyses" ADD CONSTRAINT "analyses_clip_id_clips_id_fk" FOREIGN KEY ("clip_id") REFERENCES "public"."clips"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analysis_jobs" ADD CONSTRAINT "analysis_jobs_clip_id_clips_id_fk" FOREIGN KEY ("clip_id") REFERENCES "public"."clips"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clips" ADD CONSTRAINT "clips_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "confirmation_frames" ADD CONSTRAINT "confirmation_frames_upload_id_media_uploads_id_fk" FOREIGN KEY ("upload_id") REFERENCES "public"."media_uploads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "confirmation_frames" ADD CONSTRAINT "confirmation_frames_identification_id_player_identifications_id_fk" FOREIGN KEY ("identification_id") REFERENCES "public"."player_identifications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_cleanup_locks" ADD CONSTRAINT "media_cleanup_locks_upload_id_media_uploads_id_fk" FOREIGN KEY ("upload_id") REFERENCES "public"."media_uploads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "player_candidates" ADD CONSTRAINT "player_candidates_upload_id_media_uploads_id_fk" FOREIGN KEY ("upload_id") REFERENCES "public"."media_uploads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "player_candidates" ADD CONSTRAINT "player_candidates_identification_id_player_identifications_id_fk" FOREIGN KEY ("identification_id") REFERENCES "public"."player_identifications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "player_candidates" ADD CONSTRAINT "player_candidates_representative_frame_id_confirmation_frames_id_fk" FOREIGN KEY ("representative_frame_id") REFERENCES "public"."confirmation_frames"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "player_confirmations" ADD CONSTRAINT "player_confirmations_identification_id_player_identifications_id_fk" FOREIGN KEY ("identification_id") REFERENCES "public"."player_identifications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "player_confirmations" ADD CONSTRAINT "player_confirmations_upload_id_media_uploads_id_fk" FOREIGN KEY ("upload_id") REFERENCES "public"."media_uploads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "player_identifications" ADD CONSTRAINT "player_identifications_upload_id_media_uploads_id_fk" FOREIGN KEY ("upload_id") REFERENCES "public"."media_uploads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "processing_leases" ADD CONSTRAINT "processing_leases_upload_id_media_uploads_id_fk" FOREIGN KEY ("upload_id") REFERENCES "public"."media_uploads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scotty_analysis_job_events" ADD CONSTRAINT "scotty_analysis_job_events_upload_id_media_uploads_id_fk" FOREIGN KEY ("upload_id") REFERENCES "public"."media_uploads"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scotty_analysis_job_events" ADD CONSTRAINT "scotty_analysis_job_events_job_id_scotty_analysis_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."scotty_analysis_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scotty_analysis_jobs" ADD CONSTRAINT "scotty_analysis_jobs_upload_id_media_uploads_id_fk" FOREIGN KEY ("upload_id") REFERENCES "public"."media_uploads"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scotty_analysis_reports" ADD CONSTRAINT "scotty_analysis_reports_job_id_scotty_analysis_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."scotty_analysis_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scotty_analysis_reports" ADD CONSTRAINT "scotty_analysis_reports_upload_id_media_uploads_id_fk" FOREIGN KEY ("upload_id") REFERENCES "public"."media_uploads"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "scotty_job_events_job_seq_idx" ON "scotty_analysis_job_events" USING btree ("job_id","sequence_number");--> statement-breakpoint
CREATE INDEX "scotty_job_events_request_idx" ON "scotty_analysis_job_events" USING btree ("application_request_id");--> statement-breakpoint
CREATE UNIQUE INDEX "scotty_jobs_application_request_id_uidx" ON "scotty_analysis_jobs" USING btree ("application_request_id");--> statement-breakpoint
CREATE UNIQUE INDEX "scotty_jobs_idempotency_key_uidx" ON "scotty_analysis_jobs" USING btree ("idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "scotty_jobs_provider_external_uidx" ON "scotty_analysis_jobs" USING btree ("provider","external_job_id");--> statement-breakpoint
CREATE INDEX "scotty_jobs_owner_request_idx" ON "scotty_analysis_jobs" USING btree ("owner_id","application_request_id");--> statement-breakpoint
CREATE INDEX "scotty_jobs_upload_id_idx" ON "scotty_analysis_jobs" USING btree ("upload_id");--> statement-breakpoint
CREATE INDEX "scotty_jobs_status_next_sync_idx" ON "scotty_analysis_jobs" USING btree ("canonical_status","next_sync_after");--> statement-breakpoint
CREATE INDEX "scotty_jobs_recon_updated_idx" ON "scotty_analysis_jobs" USING btree ("reconciliation_required","updated_at");--> statement-breakpoint
CREATE INDEX "scotty_jobs_report_id_idx" ON "scotty_analysis_jobs" USING btree ("report_id");--> statement-breakpoint
CREATE UNIQUE INDEX "scotty_reports_application_request_uidx" ON "scotty_analysis_reports" USING btree ("application_request_id");--> statement-breakpoint
CREATE INDEX "scotty_reports_upload_id_idx" ON "scotty_analysis_reports" USING btree ("upload_id");--> statement-breakpoint
CREATE UNIQUE INDEX "scotty_callback_event_id_uidx" ON "scotty_callback_events" USING btree ("provider","event_id");--> statement-breakpoint
CREATE INDEX "scotty_callback_job_seq_idx" ON "scotty_callback_events" USING btree ("provider","external_job_id","sequence_number");--> statement-breakpoint
CREATE UNIQUE INDEX "scotty_sim_jobs_idempotency_uidx" ON "scotty_simulator_jobs" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "scotty_sim_jobs_request_idx" ON "scotty_simulator_jobs" USING btree ("application_request_id");