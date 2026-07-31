# ChelCoach Backend — Setup Notes (Phase 0)

Phase 0 stands up the **foundation only**: the shared Analysis Contract, the Drizzle
schema, and an Express skeleton with a health check + placeholder routes. **No upload,
ffmpeg, or AI is wired.** The frontend is unchanged and still runs on mock data.

## Layout

```
chelcoach/
  shared/analysisContract.ts   # Zod schemas + inferred types (shared source of truth)
  server/                      # Express API (its own package.json — isolated from the Vite app)
    src/
      index.ts                 # server entry
      app.ts                   # express app, CORS, routers, 404 + error handler
      contract.ts              # re-export of ../../shared/analysisContract
      db/
        schema.ts              # Drizzle tables (sessions, clips, analysis_jobs, analyses)
        client.ts              # lazy Postgres/Drizzle client (boots without DB in Phase 0)
      routes/
        health.ts              # GET /api/health
        clips.ts               # placeholder upload/status/analysis routes (501)
    drizzle.config.ts
    .env.example
  replit.nix                   # nodejs_22 (+ commented ffmpeg for Phase 3)
```

The frontend (`src/…`) and backend (`server/…`) are **separate npm projects**. The
frontend's `npm run build` never touches `server/` or `shared/`, so it stays green.

## Local run

```bash
# frontend (unchanged)
cd chelcoach && npm install && npm run dev        # http://localhost:5173

# backend
cd chelcoach/server && npm install
npm run typecheck                                 # or: npm run build (tsc --noEmit)
npm run dev                                        # http://localhost:3001
curl http://localhost:3001/api/health             # {"status":"ok","phase":0,...}
```

The server boots **without** a database in Phase 0. `getDb()` is lazy and only throws
if a route that needs the DB is called (none do yet).

## Environment (`server/.env` or Replit Secrets)

| Var | When needed | Notes |
|---|---|---|
| `DATABASE_URL` | Phase 1+ / Step 10+ | Required for durable identification, retention, jobs. |
| `PORT` | optional | Defaults to `3001`. |
| `CORS_ORIGIN` | **required in production** | Comma-separated allowed origins. Empty only allowed in development. |
| `CHELCOACH_AUTH_MODE` | Step 10+ | `development_session` \| `existing_auth` \| `disabled`. |
| `CHELCOACH_PRODUCTION_AUTH_READY` | Step 10+ | Must be `true` only with real production auth (`existing_auth`). |
| `CHELCOACH_ANALYSIS_SUBMISSION_ENABLED` | production | Explicit `1` required before production analysis submissions. |
| `CHELCOACH_ANALYSIS_PROVIDER` | Step 4+ | `fake` \| `simulator` \| `direct_anthropic` \| `scotty`. Fail-closed in production. |
| `CHELCOACH_SCOTTIE_ENABLED` | Step 11 | Keep `false` until remote transport is ready. |
| `CHELCOACH_SCOTTY_SIMULATOR_ENABLED` | local/E2E | Default true in development; blocked in production without override. |
| `CHELCOACH_SCOTTY_SIMULATOR_ALLOW_IN_PRODUCTION` | staging only | Explicit override; never enable for public production. |
| `CHELCOACH_SCOTTY_CALLBACKS_ENABLED` | keep `0` | Callbacks remain disabled until signing is complete. |
| `CHELCOACH_CALLBACK_SECRET` | future | Distinct from reconcile/cleanup/signing secrets. |
| `CHELCOACH_RECONCILE_SECRET` | Step 6+ | Internal reconcile route only. |
| `CHELCOACH_CLEANUP_SECRET` | Step 10+ | Internal media cleanup; must differ from reconcile secret. |
| `CHELCOACH_E2E_MODE` / `CHELCOACH_E2E_SECRET` | test only | Startup fails if enabled in production. |
| `CHELCOACH_LEGACY_UPLOAD_ENABLED` | Step 10+ | Must be `false` in production. |
| `CHELCOACH_MEDIA_STORAGE_MODE` | Step 10+ | `local_disk` \| `memory` \| `object_storage`. |
| `CHELCOACH_PRODUCTION_MEDIA_STORAGE_READY` | production | Do not claim durable media on ephemeral disk without review. |
| `SCOTTY_BASE_URL` / `SCOTTY_SIGNING_SECRET` | Step 11 | Server-only; never expose to Vite. |
| `ANTHROPIC_API_KEY` | dev adapter only | Blocked in production provider mode. |

See `docs/scotty-step10-security-audit.md` for the full feature-flag matrix and readiness gate.

## Database (when Phase 1 begins)

1. Add Replit's **PostgreSQL** integration (sets `DATABASE_URL`).
2. `cd server && npm run db:generate` to produce SQL from `schema.ts`.
3. `npm run db:push` (or apply the generated migration) to create the tables.

## Replit deployment (target)

- **Reserved VM** deployment for the API (always-on; needed later for the background
  job poller). Run command: `cd server && npm run start` (runs via `tsx`, no compile step).
- Add **Object Storage** in Phase 1; add **ffmpeg** to `replit.nix` in Phase 3.
- The Vite frontend deploys separately (static build) and calls the API base URL.

## What Phase 0 deliberately does NOT do

- No file upload / signed URLs (Phase 1)
- No job queue / worker / status transitions (Phase 2)
- No ffmpeg frame extraction (Phase 3)
- No AI analysis (Phase 4)
- No auth, no payments (later phases)

All placeholder routes return `501 { error: "not_implemented", phase: 0 }`.
