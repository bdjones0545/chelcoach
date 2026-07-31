# ChelCoach Step 10.1A — Supabase Postgres Connection

## Purpose

Connect the existing ChelCoach Drizzle/Postgres layer to a dedicated Supabase Postgres project so durable application records can run on production-capable infrastructure.

This phase does **not** implement Supabase Auth, Storage, RLS, Vercel deploy, Cloudflare, or Scotty transport.

```text
ChelCoach server
↓
Drizzle ORM (existing repositories)
↓
Supabase Postgres
↓
Committed ChelCoach migrations
```

## Secrets (never commit)

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Runtime Postgres URI (prefer Supabase **pooler**) |
| `DATABASE_URL_MIGRATE` | Optional **direct** URI for migrations (`db.<ref>.supabase.co:5432`) |
| `SUPABASE_URL` | Project API URL (Auth/Storage later) |
| `SUPABASE_ANON_KEY` | Public anon key (unused in this phase) |
| `SUPABASE_SERVICE_ROLE_KEY` | Server admin key (unused in this phase; never send to browser) |
| `CHELCOACH_DB_SSL_MODE` | `require` (default for Supabase) |
| `CHELCOACH_DB_CONNECTION_MODE` | `auto` \| `direct` \| `pooler` \| `local` |
| `CHELCOACH_DB_STATEMENT_TIMEOUT_MS` | Default `15000` |
| `CHELCOACH_DB_MAX_CONNECTIONS` | Default `5` (Micro-friendly) |

`.env` must remain gitignored (`git check-ignore .env`).

**Do not** put the Supabase API URL into `DATABASE_URL`. Use the Database connection string from:

Supabase Dashboard → Project Settings → Database → Connection string → URI.

## Connection modes

| Mode | Typical host / port | Use |
|---|---|---|
| **Direct** | `db.<project-ref>.supabase.co:5432` | Migrations, schema admin |
| **Pooler session** | `*.pooler.supabase.com:5432` | Long-lived Node servers; prepared statements OK |
| **Pooler transaction** | `*.pooler.supabase.com:6543` | Serverless/Vercel; prepared statements unsupported |

- **Migrations in this phase:** use `DATABASE_URL_MIGRATE` (direct) when available; else `DATABASE_URL`.
- **Runtime preparation:** `DATABASE_URL` may be pooler. Transaction mode (6543) is documented; session-mode pooler is currently preferred with `node-postgres` until a `postgres.js` adapter is introduced.

## SSL

- Supabase requires TLS.
- Client builds an explicit `ssl: { rejectUnauthorized: true }` object.
- `sslmode` is stripped from the URL to avoid node-postgres override surprises.
- **Never** set `rejectUnauthorized: false` for Supabase.

## Commands

```bash
# Apply committed migrations (uses DATABASE_URL_MIGRATE if set)
npm run db:migrate

# Safe verification (tables, indexes, bounded RW, cleanup)
npm run verify:supabase-db

# Re-run migrate — must be a no-op when up to date
npm run db:migrate
```

## Migration inventory

| File | Order | Summary |
|---|---|---|
| `server/drizzle/0000_scotty_durable_jobs.sql` | 0 | Enums + all ChelCoach tables, FKs, core unique/indexes |
| `server/drizzle/0001_supabase_alignment.sql` | 1 | `processing_leases.analysis_job_id` → text; owner/cleanup/lease/frame indexes |

History table: `drizzle.__drizzle_migrations`.

## Schema tables (purpose)

| Table | Purpose | Owner field | Retention relevance |
|---|---|---|---|
| `gameplay_profiles` | Player preferences | `user_id` (text PK) | No |
| `media_uploads` | Upload metadata + retention timestamps | `owner_id` | Yes — expiry / absolute delete |
| `processing_leases` | Short processing locks | via `upload_id` | Yes — blocks cleanup while active |
| `media_cleanup_locks` | Cleanup worker locks | lock `owner` | Yes |
| `player_identifications` | Controlled-player ID state | `owner_id` | Expires with media policy |
| `confirmation_frames` | Frame metadata (no bytes) | `owner_id` | Expires / deleted with media |
| `player_candidates` | Confirmation candidates | via identification | Yes |
| `player_confirmations` | User confirmation | `owner_id` | Kept with ID record |
| `scotty_analysis_jobs` | Durable analysis jobs | `owner_id` | Independent of media delete |
| `scotty_analysis_job_events` | Append-only status history | `owner_id` | Retained |
| `scotty_analysis_reports` | Coaching reports JSONB | `owner_id` | **Survives media deletion** |
| `scotty_simulator_jobs` | Simulator lifecycle | `owner_reference` | Dev/staging |
| `scotty_callback_events` | Callback dedupe foundation | n/a | Future callbacks |
| `sessions` / `clips` / `analysis_jobs` / `analyses` | Legacy MVP path | session-scoped | Legacy |

### Database-enforced uniqueness (selected)

- `scotty_analysis_jobs.application_request_id` (unique index)
- `scotty_analysis_jobs.idempotency_key` (unique index)
- `scotty_analysis_jobs (provider, external_job_id)` (unique index)
- `scotty_analysis_reports.application_request_id` + `job_id` unique
- `scotty_callback_events (provider, event_id)` unique
- `player_identifications.upload_id` unique
- `media_cleanup_locks.upload_id` PK

### Application-enforced

- Status sequence non-regression (repository transitions)
- Ownership checks on every route (`requireOwnerAuth` + owner columns)

## Owner ID ↔ Supabase Auth UUID

Current owner columns are **`text`**. They can store Supabase `auth.users.id` UUID strings without a schema change.

Do **not** add a hard FK to `auth.users` until Option A production auth is implemented and tested.

## Runtime behavior

- When `DATABASE_URL` is set and `NODE_ENV !== test` (and memory not forced), persistence wires **Drizzle** repositories.
- `assertDatabaseReady()` pings the database; production exits on failure (no silent memory fallback).
- Readiness admin diagnostics expose only safe fields (`provider`, `connectionMode`, `ssl`, timeouts) — never the URL.

## Vercel pooler notes (not deployed yet)

- Prefer transaction pooler (`:6543`) for serverless concurrency.
- `node-postgres` + Drizzle may use prepared statements → prefer session pooler (`:5432` on pooler host) or introduce `postgres.js` with `prepare: false` in a later task.
- Keep `max` pool connections low (default 5) on Supabase Micro.
- Reuse warm clients across invocations; avoid opening a new Pool per request.

## Rollback

1. Unset / replace `DATABASE_URL` with prior local/test Postgres.
2. Restart the server.
3. Leave the Supabase schema and `drizzle.__drizzle_migrations` intact for inspection.
4. Do **not** auto-drop Supabase tables.

Destructive reset (disposable projects only): drop public tables + drizzle schema manually in the Supabase SQL editor after explicit confirmation.

## Security

- `.env` gitignored
- No frontend use of `DATABASE_URL` / service role
- Logs redact connection strings
- Public errors omit SQL/host details
- Bundle + repository secret scans remain required

## Phase status / blocker

**Live Supabase migrate + verify is blocked** until `.env` contains a Postgres URI:

```env
DATABASE_URL=postgresql://postgres.[ref]:[PASSWORD]@aws-0-[region].pooler.supabase.com:5432/postgres
DATABASE_URL_MIGRATE=postgresql://postgres:[PASSWORD]@db.[ref].supabase.co:5432/postgres
```

Do **not** paste `SUPABASE_URL` (`https://*.supabase.co`) into `DATABASE_URL`.

After keys are set:

```bash
npm run db:migrate
npm run db:migrate   # must be a no-op
npm run verify:supabase-db
```

Local non-Supabase smoke (optional): `CHELCOACH_ALLOW_NON_SUPABASE_VERIFY=1 npm run verify:supabase-db`

## Remaining risks

1. **`DATABASE_URL` must be present** in local `.env` (Postgres URI, not `SUPABASE_URL`).
2. Free-tier direct hosts may be IPv6-only — use pooler or IPv4 add-on from restricted networks.
3. Transaction pooler + `node-postgres` prepared statements (document / follow-up adapter).
4. Supabase Auth, RLS, and Storage remain future work.
