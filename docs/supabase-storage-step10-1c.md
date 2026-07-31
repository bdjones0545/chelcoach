# Step 10.1C — Supabase Storage & Direct Resumable Uploads

## Architecture

```text
Authenticated browser
↓
POST /api/uploads  (ChelCoach creates pending record + issues session)
↓
Browser TUS upload → private chelcoach-gameplay (user JWT + RLS)
↓
POST /api/uploads/:id/complete  (server stats object from DB path)
↓
Trusted media inspection (temp materialize / future worker)
↓
Upload ready for controlled-player identification
```

Gameplay video **does not** pass through a Vercel Function or the ChelCoach Express body in production Supabase mode.

ChelCoach remains authoritative for ownership, object path, upload state, trusted metadata, retention, cleanup, and later Scotty-job association.

## Private buckets

| Bucket | Purpose | Browser access |
|--------|---------|----------------|
| `chelcoach-gameplay` | Raw uploaded video | Insert/select/update **own** `{uid}/…` prefix only |
| `chelcoach-derived-media` | Confirmation frames / derived artifacts | Select own prefix only; **no** browser insert |

Both buckets must remain **private** (`public = false`).

## Storage modes

```env
CHELCOACH_MEDIA_STORAGE_MODE=local_disk   # development / CI
# CHELCOACH_MEDIA_STORAGE_MODE=supabase_storage
CHELCOACH_PRODUCTION_MEDIA_STORAGE_READY=false

SUPABASE_URL=
SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=

SUPABASE_GAMEPLAY_BUCKET=chelcoach-gameplay
SUPABASE_DERIVED_MEDIA_BUCKET=chelcoach-derived-media
```

- `local_disk` — development/test streamed PUT
- `supabase_storage` — required for production media readiness
- No silent fallback from Supabase to disk
- Production with local disk + readiness enabled fails closed

## Object-key design

Server-generated only:

```text
{authenticated-user-id}/{upload-id}/source
{authenticated-user-id}/{upload-id}/confirmation/{frame-id}.jpg
```

No client-selected permanent paths. No email, name, gamertag, or raw filename in keys.

## Upload session contract

`POST /api/uploads` returns (supabase mode):

```ts
{
  uploadId: string;
  uploadStatus: "pending";
  uploadUrl: ""; // empty — no server PUT
  transport: "supabase_resumable";
  bucket: string;
  objectPath: string; // required by TUS metadata.objectName
  resumableEndpoint: string; // {SUPABASE_URL}/storage/v1/upload/resumable
  allowedMimeTypes: string[];
  maxBytes: number;
  expiresAt: string;
  pendingExpiresAt?: string;
  retentionHours: number;
  retentionNotice: string;
}
```

Never returns service-role key, database URL, or permanent signed download URLs.

## Direct resumable upload

- Client module: `src/lib/supabaseGameplayUpload.ts`
- Dependency: **`tus-js-client`** — Supabase resumable uploads use TUS; required for chunked progress, resume, and cancel without full-file buffering
- Auth: current Supabase access token + anon `apikey` header
- Endpoint allowlist: only the configured Supabase Storage resumable URL
- Heartbeat: `POST /api/uploads/:id/transfer-active` (bounded; cannot extend past session/absolute caps)

## Completion verification

`POST /api/uploads/:id/complete`:

1. Authenticate + ownership check
2. Derive bucket/key **from the database record only**
3. Service-role `statObject`
4. Verify existence, size ≤ max, MIME sanity
5. Inspect media (see below)
6. Enforce duration ≤ 1800s; classify short / extended / full-game
7. Persist trusted metadata; mark `ready`

Browser cannot mark ready. Browser-supplied alternate paths are ignored.

## Media inspection

`SupabaseMediaObjectStorage.materializeForInspection` streams the object to a **temporary file**, runs ffprobe, and deletes the file.

**Vercel note:** downloading/inspecting a multi‑GB game inside a Vercel Function is **not** production-safe. Step 10.1D should move heavy inspection to a dedicated worker or Scotty-side handoff and keep uploads in an unverified/`processing` state until that completes. Local/dev proves the stream→temp→ffprobe path without full RAM buffering of the Node request body.

## Upload state lifecycle

```text
pending → uploading → uploaded → processing → ready
```

Also: `expired`, `deletion_pending`, `deleted`, `delete_failed`.

## Retention & cleanup

- Raw gameplay: 24h (configurable)
- Confirmation frames: inherit source expiry
- Absolute stuck-job max: 48h
- Cleanup uses `SupabaseMediaObjectStorage.deleteObject` with DB-owned keys
- Missing objects are idempotent success
- Reports are retained when media is deleted

## Storage reconciliation

`POST /api/internal/media/storage-reconcile` (reconcile secret):

Bounded DB-driven candidates for missing objects, deleted-but-present objects, expired pending leftovers, size mismatches. Does **not** scan entire buckets.

## Derived media & frame access

Frames written via service role to `chelcoach-derived-media`. Existing protected frame route remains the app boundary (ownership check + stream / optional short-lived signed URL). No permanent URLs; no service-role in the browser.

## Future Scotty media access

`createShortLivedReadUrl({ objectKey, expiresInSeconds })` on the Supabase adapter — create only when an authorized analysis job needs pull access. Not generated on normal upload completion.

## RLS policies

Repository SQL: `server/src/storage/sql/0001_storage_rls.sql`

Apply:

```bash
npm run apply:supabase-storage-rls
# or
CHELCOACH_APPLY_STORAGE_RLS=1 CHELCOACH_LIVE_STORAGE_VERIFY=1 npm run verify:supabase-storage
```

Policies:

- `chelcoach_gameplay_insert_own_prefix`
- `chelcoach_gameplay_select_own_prefix`
- `chelcoach_gameplay_update_own_prefix` (TUS)
- `chelcoach_derived_select_own_prefix`
- No authenticated delete on gameplay; no authenticated insert on derived

## Readiness gate

Media storage ready in production only when:

- mode = `supabase_storage`
- buckets configured
- `CHELCOACH_PRODUCTION_MEDIA_STORAGE_READY=true` (manual; **not** set by this step)

Keep analysis/Scotty disabled during this phase.

## Live verification

```bash
CHELCOACH_LIVE_STORAGE_VERIFY=1 CHELCOACH_APPLY_STORAGE_RLS=1 npm run verify:supabase-storage
```

Checks: config, private buckets, RLS policies, two-user isolation, service-role cleanup, derived write/delete. Does not print tokens or signed URLs.

## Legacy upload routes

| Route | Disposition |
|-------|-------------|
| `PUT /api/uploads/:id/content` | Dev/local_disk only; **409** in `supabase_storage` |
| `PUT /api/clips/:id/file` | Legacy buffered; disabled when `supabase_storage` (and must be off in production) |

## Dependency advisories

- Production path uses `@supabase/supabase-js` + `tus-js-client`
- `@replit/object-storage` remains only for optional legacy/object_storage mode — not on the Supabase production upload path
- Do not retain vulnerable production deps solely for unused adapters; revisit removal when legacy/object_storage is fully retired

## Rollback

1. Set `CHELCOACH_MEDIA_STORAGE_MODE=local_disk` for development
2. Keep `CHELCOACH_PRODUCTION_MEDIA_STORAGE_READY=false`
3. Preserve Supabase objects/records for inspection
4. Do not drop buckets or policies automatically
5. Do not delete user media as part of code rollback

## Remaining risks

- Large-file ffprobe still needs a non-Vercel worker before true production readiness
- TUS resume across full browser restarts depends on tus fingerprint storage
- Storage RLS must stay applied on the live project (verify command)

## Vercel considerations (prep only — do not deploy yet)

| Question | Finding |
|----------|---------|
| Browser uploads bypass server? | Yes, in `supabase_storage` mode (TUS direct) |
| Backend upload routes stateless? | Auth/session/complete/heartbeat are metadata-only |
| Media inspection on Vercel? | **No** for large games — needs worker |
| Completion verification on Vercel? | Stat + metadata OK; heavy inspect not OK |
| Cleanup via Vercel Cron? | Possible for DB-driven delete batches (service role) |
| Step 10.1D | Worker/inspection handoff, deploy wiring, readiness true only after live sign-off |
