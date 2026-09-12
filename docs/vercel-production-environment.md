# ChelCoach — production environment (Vercel + Supabase)

This is the authoritative inventory of what the deployed product needs, why each value exists,
and what state the deployment is in when a value is missing. The API fails closed at boot
(`server/src/config/chelcoachConfig.ts` → `assertBootConfig`), so a missing production value is
not a degraded feature — it is `FUNCTION_INVOCATION_FAILED` on every `/api/*` request.

## Why the API never worked before 2026-09-12

The Vercel project had **no environment variables at all**. Production config validation
therefore failed with `CORS_ORIGINS_REQUIRED, SCOTTY_DISABLED, SCOTTY_BASE_URL_MISSING,
SCOTTY_SIGNING_MISSING` at module load, and the frontend bundle was built with the API base
pointing at `http://localhost:3001` and no Supabase URL. The site rendered, but every
authenticated surface was dead. The fixes in this repo:

- `src/lib/apiBase.ts` — production builds default to the same origin (`/api/...`).
- `server/src/security/secrets.ts` — the four cron routes accept Vercel's shared `CRON_SECRET`
  on `GET` in addition to their distinct per-route secrets.
- `server/drizzle/0003_lock_app_tables.sql` — app tables were fully granted to `anon` and
  `authenticated` with RLS off; the anon key in the browser could read/write every row.

## Environment variables

Set for **production** and **preview** unless noted. Values marked **OWNER** are secrets that
only the account owner can obtain; the CLI/MCP tooling used to configure this deployment cannot
read them.

| Variable | Value | Notes |
|---|---|---|
| `CORS_ORIGIN` | `https://chelcoach.io,https://www.chelcoach.io` | Production only. Preview deployments need their branch alias instead. Required at boot. |
| `CHELCOACH_AUTH_MODE` | `supabase_auth` | Production identity is Supabase Auth (Bearer access token). |
| `CHELCOACH_PRODUCTION_AUTH_READY` | `true` | Honest only with `supabase_auth` + URL + anon key. |
| `SUPABASE_URL` | `https://vsigeidtmpewgjvklzwu.supabase.co` | Server-side token verification and storage. |
| `SUPABASE_ANON_KEY` | legacy anon JWT | Public key; server uses it only for `auth.getUser(jwt)`. |
| `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` | same as above | **Build-time** — a change needs a redeploy. |
| `CHELCOACH_LEGACY_UPLOAD_ENABLED` | `false` | Boot fails in production if the legacy buffered routes are on. |
| `CHELCOACH_MEDIA_STORAGE_MODE` | `local_disk` → `supabase_storage` | See "Owner-supplied secrets". `supabase_storage` fails boot without the service-role key. |
| `CHELCOACH_PRODUCTION_MEDIA_STORAGE_READY` | `false` → `true` | Flip together with the mode above. |
| `SUPABASE_GAMEPLAY_BUCKET` | `chelcoach-gameplay` | Private bucket; exists, RLS policies applied. |
| `SUPABASE_DERIVED_MEDIA_BUCKET` | `chelcoach-derived-media` | Private bucket; exists, RLS policies applied. |
| `CHELCOACH_ANALYSIS_PROVIDER` | `simulator` (interim) | Boots, but declares `canServeProductionTraffic=false`, so submission stays disabled. Replaced by the real provider. |
| `CHELCOACH_SCOTTY_SIMULATOR_ENABLED` | `true` | Required by the interim provider. |
| `CHELCOACH_SCOTTY_SIMULATOR_ALLOW_IN_PRODUCTION` | `true` | Interim only. |
| `CHELCOACH_ANALYSIS_SUBMISSION_ENABLED` | `false` → `1` | The explicit production enable. Only set to `1` once every readiness reason is clear. |
| `CHELCOACH_SCOTTIE_ENABLED` | `false` | The remote HTTP Scotty transport is not used. |
| `CHELCOACH_DB_SSL_MODE` | `require` | Supabase pooler TLS; CA chain is committed in `server/certs`. |
| `CRON_SECRET` | generated | Vercel sends `Authorization: Bearer <CRON_SECRET>` on every cron `GET`. Must be ≥16 chars. |
| `CHELCOACH_RECONCILE_SECRET` | generated | Distinct per-route operator secret. |
| `CHELCOACH_CLEANUP_SECRET` | generated | Distinct. |
| `CHELCOACH_INSPECTION_WORKER_SECRET` | generated | Distinct. |
| `DATABASE_URL` | **OWNER** | Supabase **session-mode pooler** URI (port 5432, `*.pooler.supabase.com`). Without it the API runs with in-memory repositories and analysis stays disabled (`DURABLE_DATABASE_REQUIRED`). |
| `DATABASE_URL_MIGRATE` | **OWNER** | Optional direct URI for `npm run db:migrate`. Falls back to `DATABASE_URL`. |
| `SUPABASE_SERVICE_ROLE_KEY` | **OWNER** | Required for `supabase_storage` (stat, signed URLs, derived-frame writes, cleanup). Never in `VITE_*`. |
| `ANTHROPIC_API_KEY` | **OWNER** | Required by the real analysis provider. |

## Owner-supplied secrets — the exact steps

1. Supabase dashboard → Project Settings → API → copy the **service_role** key.
2. Supabase dashboard → Project Settings → Database → **Session pooler** connection string
   (port 5432) with the database password.
3. Anthropic Console → API key for the ChelCoach workspace.
4. From the repo root (the project is linked to `train-efficiency/chelcoach`), run the committed
   configuration script. It sets every non-secret value, generates the four internal secrets, and
   stores the owner secrets you pass in — switching media storage to `supabase_storage` when the
   service-role key is present:

```bash
SUPABASE_ANON_KEY="<anon key>" \
SUPABASE_SERVICE_ROLE_KEY="<service_role key>" \
DATABASE_URL="<session pooler URI>" \
ANTHROPIC_API_KEY="<anthropic key>" \
bash scripts/configure-vercel-env.sh
```

5. Apply migrations to production once (this also locks the app tables away from the anon key):

```bash
DATABASE_URL="<session pooler URI>" npm run db:migrate
```

6. Redeploy `main` **without build cache** (the `VITE_*` values are baked at build time).

## Supabase Auth dashboard settings (owner)

- Authentication → URL Configuration → **Site URL** `https://chelcoach.io`.
- **Redirect URLs**: `https://chelcoach.io/reset-password`, `https://www.chelcoach.io/reset-password`.
- Email confirmations: leave on (the signup screen tells the user to check email) or disable for
  a frictionless MVP — a product decision, not a code one.

## Verifying a deployment

```bash
curl -s https://chelcoach.io/api/health            # 200 {"status":"ok",...}
curl -s https://chelcoach.io/api/health/readiness  # 503 {"analysisSubmission":"disabled"} until fully enabled
```

An authenticated owner can read the full readiness reasons at `GET /api/admin/readiness`.
