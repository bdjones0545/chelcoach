-- Step 10.1D — Durable media inspection jobs (worker boundary)
-- Raw video / signed URLs / secrets are NEVER stored here.

DO $$ BEGIN
  CREATE TYPE "public"."media_inspection_status" AS ENUM(
    'queued',
    'claimed',
    'downloading',
    'inspecting',
    'validating',
    'completed',
    'failed',
    'cancelled',
    'expired'
  );
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "media_inspection_jobs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "upload_id" uuid NOT NULL REFERENCES "media_uploads"("id") ON DELETE CASCADE,
  "owner_id" text NOT NULL,
  "storage_provider" text NOT NULL,
  "bucket_alias" text NOT NULL,
  "object_key" text NOT NULL,
  "object_fingerprint" text NOT NULL,
  "contract_version" text NOT NULL DEFAULT '1.0.0',
  "status" "media_inspection_status" NOT NULL DEFAULT 'queued',
  "attempt_count" integer NOT NULL DEFAULT 0,
  "max_attempts" integer NOT NULL DEFAULT 3,
  "worker_id" text,
  "claimed_at" timestamptz,
  "claim_expires_at" timestamptz,
  "heartbeat_at" timestamptz,
  "started_at" timestamptz,
  "completed_at" timestamptz,
  "failed_at" timestamptz,
  "next_attempt_at" timestamptz,
  "trusted_byte_size" bigint,
  "trusted_mime_type" text,
  "trusted_duration_sec" double precision,
  "video_codec" text,
  "audio_codec" text,
  "width" integer,
  "height" integer,
  "frame_rate" double precision,
  "rotation" integer,
  "media_classification" text,
  "error_code" text,
  "error_message" text,
  "retryable" boolean NOT NULL DEFAULT true,
  "version" integer NOT NULL DEFAULT 1,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "media_inspection_jobs_upload_fingerprint_uidx"
  ON "media_inspection_jobs" ("upload_id", "object_fingerprint");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "media_inspection_jobs_claim_idx"
  ON "media_inspection_jobs" ("status", "next_attempt_at", "claim_expires_at");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "media_inspection_jobs_upload_id_idx"
  ON "media_inspection_jobs" ("upload_id");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "media_inspection_jobs_owner_id_idx"
  ON "media_inspection_jobs" ("owner_id");
