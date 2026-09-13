-- Grants for the API's own database role (Supabase only).
--
-- The API never connects as `postgres`. It uses `chelcoach_app`, a LOGIN role with BYPASSRLS that
-- is created out of band (it carries a password, which never belongs in a migration):
--   CREATE ROLE chelcoach_app LOGIN BYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE
--     CONNECTION LIMIT 20 PASSWORD '<minted>';
-- This migration grants that role the application tables and sequences, plus default privileges
-- so tables created by later migrations (run as `postgres`) are covered automatically. On plain
-- Postgres (CI, local) the role does not exist and this is a no-op.
DO $$
DECLARE
  t text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'chelcoach_app') THEN
    RETURN;
  END IF;
  EXECUTE 'GRANT USAGE ON SCHEMA public TO chelcoach_app';
  FOREACH t IN ARRAY ARRAY[
    'analyses', 'analysis_jobs', 'clips', 'confirmation_frames', 'gameplay_profiles',
    'media_cleanup_locks', 'media_uploads', 'player_candidates', 'player_confirmations',
    'player_identifications', 'processing_leases', 'scotty_analysis_job_events',
    'scotty_analysis_jobs', 'scotty_analysis_reports', 'scotty_callback_events',
    'scotty_simulator_jobs', 'sessions', 'media_inspection_jobs', 'scotty_worker_jobs'
  ] LOOP
    IF to_regclass('public.' || quote_ident(t)) IS NOT NULL THEN
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.%I TO chelcoach_app', t);
    END IF;
  END LOOP;
  EXECUTE 'GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO chelcoach_app';
  EXECUTE 'ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO chelcoach_app';
  EXECUTE 'ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO chelcoach_app';
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'drizzle') THEN
    EXECUTE 'GRANT USAGE ON SCHEMA drizzle TO chelcoach_app';
    EXECUTE 'GRANT SELECT ON ALL TABLES IN SCHEMA drizzle TO chelcoach_app';
  END IF;
END $$;
