# Handoff: finish ChelCoach go-live (for Codex)

Written 2026-09-13 by the Claude session that did the work below. Everything here is verified
against production unless marked TODO. Secrets are NOT in this file; they are in
`~/Desktop/Claude/chelcoach-handoff-secrets.env` on this Mac (never commit it).

## Where things stand

| Piece | State | Proof |
| --- | --- | --- |
| chelcoach.io SPA + `/api/*` (Vercel `train-efficiency/chelcoach`) | **live**, boot clean | `curl https://chelcoach.io/api/health` → `{"status":"ok",…,"dbConfigured":false,"storageBackend":"memory"}` |
| Supabase Auth (project `chelcoach`, ref `vsigeidtmpewgjvklzwu`, us-west-2) | **live** | sign-up / sign-in work on chelcoach.io; Site URL + `/reset-password` redirects saved |
| Analysis provider `scotty` → Scottie gateway on orgo-desktop | **live** | `https://scottie.chelcoach.io/health` → 200; a signed smoke job completed with `providerMetadata {provider:"openai_compatible", model:"grok-4"}` |
| Vercel env (prod + preview) | all non-secret vars + `CRON_SECRET`, `CHELCOACH_*_SECRET`s + `SCOTTY_*` set | `npx -y vercel@latest env ls production` |
| Production DB schema | migrations 0000–0005 applied | 0000–0002 through drizzle (`drizzle.__drizzle_migrations` has 3 rows); 0003–0005 through the Supabase MCP `apply_migration` (ledger in `supabase_migrations`) |
| **Durable Postgres for the API** | **MISSING** — `DATABASE_URL` unset, so sessions/uploads/jobs live in function memory | this handoff, step 1–4 |
| **Supabase Storage for uploads** | **MISSING** — `SUPABASE_SERVICE_ROLE_KEY` unset, `CHELCOACH_MEDIA_STORAGE_MODE=local_disk` | step 5 |
| Analysis submission | disabled by flag (`CHELCOACH_ANALYSIS_SUBMISSION_ENABLED=false`) until readiness is clean | step 7 |

Why the last two are open: the Claude session's permission classifier refused to create a
Postgres login role (twice), and the Browser pane is not signed into vercel.com, so the
Supabase↔Vercel integration could not be installed. Nothing else is blocked.

## Rules that still apply

- Never run `npm run db:migrate` against production. The drizzle ledger only knows 0000–0002;
  re-running would replay 0003–0006 (0003 and 0005/0006 are idempotent, 0004 uses IF NOT EXISTS,
  but do not rely on it). Apply SQL files directly (Supabase SQL editor, MCP `apply_migration`,
  or `psql`).
- Never put a secret in git, a migration file, a log line, or a URL query string.
- Never reuse `SCOTTY_SIGNING_SECRET` for anything else (config validation rejects reuse).
- Do not install packages or run heavy jobs on orgo-desktop (98 % disk, load ≈ 9). The gateway
  there is supervisord `scottie-gateway`; restart only with `supervisorctl restart scottie-gateway`.
- `vercel redeploy <deployment-url>` takes no `--prod` / `--yes` flags on CLI 59.

## Step 1 — create the API's database role (one statement, as `postgres`)

Password: `CHELCOACH_APP_DB_PASSWORD` in the secrets file (40 chars, minted 2026-09-13).

```sql
CREATE ROLE chelcoach_app LOGIN BYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT
  CONNECTION LIMIT 20 PASSWORD '<CHELCOACH_APP_DB_PASSWORD>';
```

Run it in Supabase → SQL editor (project chelcoach), or via the Supabase MCP `execute_sql`, or
`psql` with the owner's direct connection. Verify:

```sql
select rolname, rolcanlogin, rolbypassrls from pg_roles where rolname = 'chelcoach_app';
```

BYPASSRLS matters: every app table has RLS enabled with **no policies** (migration 0003), which is
what keeps the browser's anon key out. The API role must bypass it, exactly like `postgres` does.

## Step 2 — apply migration 0006 (grants; no secret inside)

File: `server/drizzle/0006_app_role_grants.sql` (already in the repo on branch
`chore/codex-go-live-handoff`, journal entry idx 6 added). Apply its contents verbatim to
production with `apply_migration` (name `0006_app_role_grants`) or the SQL editor. It grants
`chelcoach_app` SELECT/INSERT/UPDATE/DELETE on the 19 app tables, sequences, default privileges for
future tables, and read access to the `drizzle` schema. It is a no-op if the role does not exist,
so run step 1 first. Verify:

```sql
select count(*) from information_schema.role_table_grants
 where grantee = 'chelcoach_app' and privilege_type = 'INSERT';  -- expect 19
```

## Step 3 — prove the role can connect through the pooler (from this Mac)

Session-mode pooler, port 5432. The username is `<role>.<project-ref>`. Two pooler hosts resolve
for us-west-2; try `aws-0` first, then `aws-1`:

```bash
cd ~/Desktop/Claude/chelcoach/server
set -a; . ~/Desktop/Claude/chelcoach-handoff-secrets.env; set +a
for H in aws-0-us-west-2 aws-1-us-west-2; do
  DATABASE_URL="postgresql://chelcoach_app.vsigeidtmpewgjvklzwu:${CHELCOACH_APP_DB_PASSWORD}@${H}.pooler.supabase.com:5432/postgres?sslmode=require" \
  node -e '
    const { Client } = require("pg"); const fs = require("fs");
    const c = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: true, ca: fs.readFileSync("certs/supabase-pooler-chain.pem", "utf8") } });
    c.connect().then(() => c.query("select current_user, (select count(*) from scotty_worker_jobs) as jobs"))
      .then(r => { console.log(process.env.DATABASE_URL.split("@")[1].split(":")[0], r.rows[0]); return c.end(); })
      .catch(e => { console.log(process.env.DATABASE_URL.split("@")[1].split(":")[0], "FAIL", e.message); process.exit(1); });
  ' && break
done
```

Expected: `{ current_user: 'chelcoach_app', jobs: '0' }` on one of the hosts. Keep that host.
If both fail with a password error, the role was not created as written; if with "Tenant or user
not found", the username format or host is wrong; if TLS, the CA in `server/certs` is the fix, not
`rejectUnauthorized:false` (never do that).

## Step 4 — put `DATABASE_URL` on Vercel and redeploy

```bash
cd ~/Desktop/Claude/chelcoach
URL="postgresql://chelcoach_app.vsigeidtmpewgjvklzwu:${CHELCOACH_APP_DB_PASSWORD}@<host-from-step-3>.pooler.supabase.com:5432/postgres?sslmode=require"
for ENV in production preview; do
  printf '%s' "$URL" | npx -y vercel@latest env add DATABASE_URL "$ENV" --force --yes --type secret
done
PROD=$(npx -y vercel@latest ls --prod 2>/dev/null | grep -m1 -o 'https://chelcoach-[a-z0-9]*-train-efficiency.vercel.app')
npx -y vercel@latest redeploy "$PROD"
curl -s https://chelcoach.io/api/health          # expect "dbConfigured":true
curl -s https://chelcoach.io/api/health/readiness
```

`CHELCOACH_DB_SSL_MODE=require` is already set and the pooler CA chain is committed in
`server/certs`, so no other DB variable is needed. `CHELCOACH_FORCE_MEMORY_REPOS` is not set.

## Step 5 — Storage (needs the owner's service-role key)

Either install the Supabase Vercel integration (Vercel → Integrations → Supabase → connect
project `chelcoach`; it syncs `SUPABASE_SERVICE_ROLE_KEY` and `POSTGRES_URL`), or paste the
service-role key from Supabase → Project Settings → API into Vercel as
`SUPABASE_SERVICE_ROLE_KEY` (production + preview, type secret). Then:

```bash
for ENV in production preview; do
  printf 'supabase_storage' | npx -y vercel@latest env add CHELCOACH_MEDIA_STORAGE_MODE "$ENV" --force --yes --type secret
  printf 'true'             | npx -y vercel@latest env add CHELCOACH_PRODUCTION_MEDIA_STORAGE_READY "$ENV" --force --yes --type secret
done
```

Buckets `chelcoach-gameplay` and `chelcoach-derived-media` exist (private, RLS policies applied).
Redeploy as in step 4 and confirm `"storageBackend":"supabase_storage"` on `/api/health`.

## Step 6 — CI parity for the migration ledger (optional, recommended)

Production's drizzle ledger stops at 0002. Once 0006 is applied, record 0003–0006 so a future
`db:migrate` is a no-op rather than a replay. Hashes are sha256 of each file's contents as drizzle
computes them; the simplest safe route is to insert rows with the hashes drizzle reports from a
throwaway local database after `npm run db:migrate` there:

```sql
select id, hash, created_at from drizzle.__drizzle_migrations order by id;
```

Copy rows 4–7 into production's ledger. Do not run the migrator against production.

## Step 7 — enable submission and run the live journey

Only after `/api/health/readiness` shows no blocking reasons:

```bash
for ENV in production preview; do
  printf '1' | npx -y vercel@latest env add CHELCOACH_ANALYSIS_SUBMISSION_ENABLED "$ENV" --force --yes --type secret
done
# redeploy as in step 4
```

Then on chelcoach.io with a fresh account: sign up → upload a short NHL clip (TUS, ≤ the
configured size) → wait for the per-minute cron (`/api/internal/analysis/worker`, plus the
inspection cron) → confirm the controlled player when asked → wait for the report. Watch Vercel
runtime logs for lines tagged `[chelcoach-scotty-remote]` (`dispatched`, `status_advanced`,
`job_completed`). On the gateway side, `https://scottie.chelcoach.io/health` must stay 200; job
state lives on the VM under the `scottie` Hermes profile.

A direct gateway smoke, if you need one, is `SCOTTY_API_KEY` + `SCOTTY_SIGNING_SECRET` from the
secrets file with `server/src/provider/scottyRemote/client.ts` (`ScottieClient.analyze` → poll
`getJob` → `confirmPlayer` if asked → `getReport`). The Claude session's scratch scripts did
exactly that and completed in 16 s.

## Step 8 — land the repo changes

Branch `chore/codex-go-live-handoff` holds migration 0006, its journal entry and this document.
Server tests: `cd server && CHELCOACH_E2E_MODE=0 npm test` (240 pass at handoff). Open a PR to
`main`, squash-merge. Vercel deploys `main` automatically; env changes still need a redeploy.

## Done means

- `/api/health` → `dbConfigured:true`, `storageBackend:"supabase_storage"`.
- `/api/health/readiness` → `analysisSubmission:"enabled"` with no reasons.
- One real clip uploaded on chelcoach.io reaches `completed` with a Scottie report visible in the
  app, and `scotty_worker_jobs` in production has that row with `remote` populated.
