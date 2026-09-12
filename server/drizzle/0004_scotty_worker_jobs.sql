-- Scotty worker provider: real analysis runs in-process (ffmpeg frame sampling + vision model)
-- with durable, lease-claimed jobs. No media bytes or signed URLs are ever stored here.
ALTER TYPE "public"."analysis_provider" ADD VALUE IF NOT EXISTS 'scotty_worker';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "scotty_worker_jobs" (
	"external_job_id" text PRIMARY KEY NOT NULL,
	"application_request_id" text NOT NULL,
	"upload_id" text NOT NULL,
	"owner_reference" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_fingerprint" text NOT NULL,
	"contract_version" text NOT NULL,
	"submission" jsonb NOT NULL,
	"status" "scotty_job_status" DEFAULT 'queued' NOT NULL,
	"sequence_number" integer DEFAULT 1 NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 3 NOT NULL,
	"worker_id" text,
	"claim_expires_at" timestamp with time zone,
	"next_attempt_at" timestamp with time zone,
	"accepted_at" timestamp with time zone NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"failed_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"cancel_reason" text,
	"error_code" text,
	"error_message" text,
	"retryable" boolean DEFAULT false NOT NULL,
	"report" jsonb,
	"frame_count" integer,
	"model_usage" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "scotty_worker_jobs_idempotency_uidx" ON "scotty_worker_jobs" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "scotty_worker_jobs_request_idx" ON "scotty_worker_jobs" USING btree ("application_request_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "scotty_worker_jobs_claim_idx" ON "scotty_worker_jobs" USING btree ("status","claim_expires_at","next_attempt_at");--> statement-breakpoint
-- Backend-only table: keep it away from the Supabase API roles like every other app table.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname IN ('anon', 'authenticated')) THEN
    EXECUTE 'REVOKE ALL ON TABLE public.scotty_worker_jobs FROM anon, authenticated';
  END IF;
  EXECUTE 'ALTER TABLE public.scotty_worker_jobs ENABLE ROW LEVEL SECURITY';
END $$;
