-- Remote dispatch state for provider mode `scotty` (analysis on the Scottie gateway).
ALTER TABLE "scotty_worker_jobs" ADD COLUMN IF NOT EXISTS "remote" jsonb;
