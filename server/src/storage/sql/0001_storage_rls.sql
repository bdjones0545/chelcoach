-- ChelCoach Step 10.1C — Supabase Storage RLS policies
-- Repository-managed setup script (NOT applied by Drizzle migrator).
-- Apply against the Supabase Postgres project that owns the Storage API:
--   npm run apply:supabase-storage-rls
-- or via verify:supabase-storage (live mode).
--
-- Buckets (must already exist and remain PRIVATE):
--   chelcoach-gameplay
--   chelcoach-derived-media
--
-- Path convention:
--   gameplay: {auth.uid}/{uploadId}/source
--   derived:  {auth.uid}/{uploadId}/confirmation/{frameId}.jpg
--
-- Service-role clients bypass RLS for cleanup / derived writes / trusted stat.

-- Ensure buckets stay private (idempotent).
UPDATE storage.buckets
SET public = false
WHERE id IN ('chelcoach-gameplay', 'chelcoach-derived-media');

-- ---------------------------------------------------------------------------
-- Gameplay bucket — authenticated users may insert/select/update OWN prefix only.
-- No broad DELETE for browser users (cleanup uses service role).
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS "chelcoach_gameplay_insert_own_prefix" ON storage.objects;
CREATE POLICY "chelcoach_gameplay_insert_own_prefix"
ON storage.objects
FOR INSERT
TO authenticated
WITH CHECK (
  bucket_id = 'chelcoach-gameplay'
  AND (storage.foldername(name))[1] = (select auth.uid()::text)
);

DROP POLICY IF EXISTS "chelcoach_gameplay_select_own_prefix" ON storage.objects;
CREATE POLICY "chelcoach_gameplay_select_own_prefix"
ON storage.objects
FOR SELECT
TO authenticated
USING (
  bucket_id = 'chelcoach-gameplay'
  AND (storage.foldername(name))[1] = (select auth.uid()::text)
);

-- Resumable (TUS) uploads may UPDATE object metadata / partial state.
DROP POLICY IF EXISTS "chelcoach_gameplay_update_own_prefix" ON storage.objects;
CREATE POLICY "chelcoach_gameplay_update_own_prefix"
ON storage.objects
FOR UPDATE
TO authenticated
USING (
  bucket_id = 'chelcoach-gameplay'
  AND (storage.foldername(name))[1] = (select auth.uid()::text)
)
WITH CHECK (
  bucket_id = 'chelcoach-gameplay'
  AND (storage.foldername(name))[1] = (select auth.uid()::text)
);

-- Explicitly NO delete policy for authenticated on gameplay.
-- Backend / cleanup uses service role.

-- ---------------------------------------------------------------------------
-- Derived-media bucket — browser users may SELECT own confirmation frames only.
-- No INSERT / UPDATE / DELETE for authenticated (service role only for writes).
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS "chelcoach_derived_select_own_prefix" ON storage.objects;
CREATE POLICY "chelcoach_derived_select_own_prefix"
ON storage.objects
FOR SELECT
TO authenticated
USING (
  bucket_id = 'chelcoach-derived-media'
  AND (storage.foldername(name))[1] = (select auth.uid()::text)
);

-- Drop any overly broad authenticated insert policies if previously created by hand.
DROP POLICY IF EXISTS "chelcoach_derived_insert_own_prefix" ON storage.objects;
-- Intentionally not recreated — browser insert to derived media is forbidden.
