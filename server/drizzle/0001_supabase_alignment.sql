-- Step 10.1A forward migration: align lease job refs + production query indexes.
-- Applied after 0000_scotty_durable_jobs on clean databases (including Supabase).

-- Domain uses text processing references (e.g. submit-<uuid>), not only UUIDs.
ALTER TABLE "processing_leases" ALTER COLUMN "analysis_job_id" SET DATA TYPE text;--> statement-breakpoint

-- Owner-scoped upload lookup
CREATE INDEX IF NOT EXISTS "media_uploads_owner_id_idx" ON "media_uploads" USING btree ("owner_id");--> statement-breakpoint

-- Cleanup / retention candidate queries
CREATE INDEX IF NOT EXISTS "media_uploads_status_expires_idx" ON "media_uploads" USING btree ("upload_status","expires_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "media_uploads_absolute_delete_idx" ON "media_uploads" USING btree ("absolute_delete_at");--> statement-breakpoint

-- Active processing leases by upload
CREATE INDEX IF NOT EXISTS "processing_leases_upload_status_expires_idx" ON "processing_leases" USING btree ("upload_id","status","expires_at");--> statement-breakpoint

-- Identification ownership / upload path already has unique upload_id; owner index for audits
CREATE INDEX IF NOT EXISTS "player_identifications_owner_id_idx" ON "player_identifications" USING btree ("owner_id");--> statement-breakpoint

-- Frame lookup by upload
CREATE INDEX IF NOT EXISTS "confirmation_frames_upload_id_idx" ON "confirmation_frames" USING btree ("upload_id");
