# Step 10.1D — Media Inspection Worker & Vercel Control Plane

## Architecture

```text
Browser → TUS → private Supabase Storage
↓
POST /api/uploads/:id/complete  (Vercel/API: metadata only)
↓
media_inspection_jobs (queued)
↓
Dedicated worker (Scotty VM / media worker) claims job
↓
Stream object → temp file → ffprobe → validate
↓
Persist trusted metadata → upload ready
```

The Vercel API is a **stateless control plane**. It never downloads full games, never runs ffprobe, and never depends on durable local disk for media.

## Worker placement decision

**Preferred: Scotty VM / always-on media worker process** (`npm run worker:media-inspection`).

Rationale:

* ffmpeg/ffprobe belong near the analysis runtime,
* large files never enter Vercel,
* no second public transport required,
* inspection remains a distinct job type and does **not** start gameplay analysis.

Transport: **database-claim model** against Supabase Postgres (`FOR UPDATE SKIP LOCKED`).

## Job schema

Table: `media_inspection_jobs` (migration `0002_media_inspection_jobs.sql`).

Statuses (separate from upload status):

```text
queued → claimed → downloading → inspecting → validating → completed
                                                     ↘ failed | cancelled | expired
```

Idempotency: unique `(upload_id, object_fingerprint)`.

## Object-version integrity

Fingerprint from Storage metadata (`version|etag|size|updated_at`) persisted at enqueue.

Worker re-stats before and after materialization; mismatch → `STORAGE_OBJECT_MISMATCH` (no ready).

## Secure Storage access

Worker uses the **service-role** Supabase Storage client (`SupabaseMediaObjectStorage`) on the worker host only.

Credentials are never logged and never sent to the browser.

## Streaming & disk

* Stream to server-generated temp path under `CHELCOACH_INSPECTION_TMPDIR`
* Enforce max bytes while streaming
* Check available disk ≥ object size + 256 MiB margin → `INSUFFICIENT_WORKER_DISK`
* Cleanup temp on success/failure/cancel; stale cleanup on worker start

## ffprobe

* `spawn` with argument array (no shell)
* Bounded stdout/stderr
* Timeout → `INSPECTION_TIMEOUT`
* Raw stderr never returned to users

## Completion endpoint

In `supabase_storage` (or `CHELCOACH_MEDIA_INSPECTION_MODE=worker`):

1. Auth + ownership
2. Stat object from DB path
3. Mark `uploaded` then `processing`
4. Create/reuse inspection job
5. Return processing + public inspection summary + `pollAfterMs`

Does **not** mark `ready`. Does **not** run ffprobe.

`local_disk` development/CI may still inspect inline for E2E convenience.

## Frontend

After TUS complete → poll `GET /api/uploads/:id` with Stage 7-style controller (`uploadInspectionPoller.ts`).

Stages (labels only, no fake %):

* Upload complete
* Waiting for verification
* Inspecting gameplay video
* Validating media
* Ready for player identification

Reload recovery via `?uploadId=` on `/upload`.

## Retention / cleanup

* `processing` uploads defer normal cleanup until expiry / absolute max
* Cleanup cancels active inspection jobs before deleting objects
* Absolute 48h maximum remains authoritative
* Stale claims recover after lease expiry; they do not retain media forever

## Vercel strategy (Option A)

Wrap Express via `api/index.ts` → `server/src/vercelApp.ts` (no `listen()` when `VERCEL` is set).

Install/build: see `docs/vercel-deployment.md`. Vercel must install **root + `shared` + `server`** via `scripts/install-all.sh` (`vercel.json` `installCommand`). Root-only `npm ci` is insufficient.

Safe on Vercel: auth, profiles, upload session/complete/status, analysis status/report, confirmation, readiness, internal cron kicks (metadata).

Unsafe on Vercel: ffprobe, full download, local durable media, in-process worker inline mode.

### Environment inventory

Frontend-safe:

* `VITE_SUPABASE_URL`
* `VITE_SUPABASE_ANON_KEY`

Server-only:

* `SUPABASE_URL` / `SUPABASE_ANON_KEY` / `SUPABASE_SERVICE_ROLE_KEY`
* `DATABASE_URL` (session pooler)
* `CHELCOACH_AUTH_MODE` / `CHELCOACH_PRODUCTION_AUTH_READY`
* `CHELCOACH_MEDIA_STORAGE_MODE` / `CHELCOACH_PRODUCTION_MEDIA_STORAGE_READY`
* `CHELCOACH_ANALYSIS_SUBMISSION_ENABLED=false`
* `CHELCOACH_SCOTTIE_ENABLED=false`
* `CHELCOACH_CLEANUP_SECRET` / `CHELCOACH_RECONCILE_SECRET` / `CHELCOACH_INSPECTION_WORKER_SECRET`

Worker-only:

* Same Supabase + DB credentials
* `FFPROBE_PATH` / `FFMPEG_PATH` (optional)
* `CHELCOACH_INSPECTION_TMPDIR`
* `CHELCOACH_INSPECTION_WORKER_ID`

### Preview operator steps

1. Merge/deploy branch to Vercel preview
2. Set env vars above (readiness flags **false**)
3. Confirm API `/api/health` and `/api/readiness`
4. Confirm Auth sign-in
5. Confirm TUS upload hits Supabase Storage host (not Vercel body)
6. Confirm complete returns `processing` and creates `media_inspection_jobs` row
7. Run `npm run worker:media-inspection` against the same DB/Storage
8. Confirm upload becomes `ready`
9. Bundle/secret scan on preview assets

Do not enable analysis or production media readiness until live worker sign-off.

## Cron preparation

`vercel.json` lists hourly cleanup / reconcile and minute inspection wake.

* Cron should only wake control-plane batches
* Inspection wake with `CHELCOACH_INSPECTION_WORKER_INLINE=0` does **not** run ffprobe
* Preferred: external scheduler calling internal routes with secrets, plus a dedicated worker process

## Legacy dependency disposition

`@replit/object-storage` (and transitive `@google-cloud/storage` / `uuid`) remains **lazy-loaded only when `STORAGE_BACKEND=replit`**. It is not on the Supabase/Vercel media path. Full removal is deferred until legacy clip routes are retired; not required for production supabase_storage.

## Verification

```bash
npm run db:migrate
npm run verify:media-worker
CHELCOACH_LIVE_MEDIA_WORKER_VERIFY=1 npm run verify:media-worker
npm run worker:media-inspection
```

## Rollback

* Stop worker claiming
* Keep `CHELCOACH_PRODUCTION_MEDIA_STORAGE_READY=false`
* Keep analysis disabled
* Preserve inspection job rows and uploaded objects for bounded inspection
* Local_disk inline inspection remains available in development

## Remaining risks

* Preview deployment requires operator Vercel project access
* Worker must be provisioned on an always-on host before production media readiness
* Vercel Cron secret wiring must be validated per project
