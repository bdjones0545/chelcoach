-- Lock ChelCoach application tables away from the Supabase API roles.
--
-- Every application table is backend-only: the API reaches Postgres over DATABASE_URL with a role
-- that bypasses row security, and the browser never queries app tables directly. On Supabase,
-- however, tables created in `public` are granted to `anon` and `authenticated` by default and are
-- served by PostgREST — so the anon key shipped in the browser bundle could read and write every
-- row. Revoke those grants and enable row-level security with no policies, which denies the API
-- roles even if a grant is ever re-added.
--
-- The roles only exist on Supabase; on plain Postgres (CI, local) the grant step is skipped and
-- RLS is still enabled, which is a no-op for the owning role.
DO $$
DECLARE
  t text;
  api_roles_exist boolean;
BEGIN
  SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname IN ('anon', 'authenticated'))
    INTO api_roles_exist;
  FOREACH t IN ARRAY ARRAY[
    'analyses', 'analysis_jobs', 'clips', 'confirmation_frames', 'gameplay_profiles',
    'media_cleanup_locks', 'media_uploads', 'player_candidates', 'player_confirmations',
    'player_identifications', 'processing_leases', 'scotty_analysis_job_events',
    'scotty_analysis_jobs', 'scotty_analysis_reports', 'scotty_callback_events',
    'scotty_simulator_jobs', 'sessions', 'media_inspection_jobs'
  ] LOOP
    IF api_roles_exist THEN
      EXECUTE format('REVOKE ALL ON TABLE public.%I FROM anon, authenticated', t);
    END IF;
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;
