# ChelCoach Step 10.1B — Supabase Auth as production identity

## Architecture

```text
Browser (Supabase JS client)
↓  email/password session (PKCE)
↓  Authorization: Bearer <access_token>
ChelCoach backend requireOwnerAuth
↓  supabase.auth.getUser(jwt)
↓  ownerId = auth.users.id (UUID string)
Existing ownership / Drizzle repositories
↓
Supabase Postgres
```

Application tables remain backend-only (Drizzle). **No browser queries against app tables.** RLS for Storage is a later phase.

## Auth mode configuration

| `CHELCOACH_AUTH_MODE` | Behavior |
|---|---|
| `development_session` | Opaque local/E2E mint (`POST /api/session`) |
| `supabase_auth` | Production Supabase Auth (Bearer access token) |
| `existing_auth` | Alias → `supabase_auth` when `CHELCOACH_EXISTING_AUTH_PROVIDER=supabase` |
| `disabled` | Authed routes return `AUTH_DISABLED` |

Production defaults stay fail-closed:

```env
CHELCOACH_AUTH_MODE=disabled   # or leave unset only in local; prod must be explicit
CHELCOACH_PRODUCTION_AUTH_READY=false
CHELCOACH_ANALYSIS_SUBMISSION_ENABLED=false
CHELCOACH_SCOTTIE_ENABLED=false
```

Activate deliberately:

```env
CHELCOACH_AUTH_MODE=supabase_auth
CHELCOACH_PRODUCTION_AUTH_READY=true
SUPABASE_URL=...
SUPABASE_ANON_KEY=...
```

Frontend (build-time):

```env
VITE_SUPABASE_URL=
VITE_SUPABASE_ANON_KEY=
```

Never put `SUPABASE_SERVICE_ROLE_KEY` or `DATABASE_URL` in Vite env.

## Auth transport

**Option A — Bearer token** (chosen).

- Browser sends `Authorization: Bearer <Supabase access_token>`.
- Compatible with existing CSRF model (custom header + origin allowlist; auth is not a cookie).
- No ChelCoach session cookie required.

## Token verification

Server uses `@supabase/supabase-js` anon client + `auth.getUser(accessToken)`.

- Validates with Supabase Auth (signature / expiry).
- Does **not** decode JWT payloads without verification.
- Does **not** use the service-role key for normal user authentication.
- Maps failures to safe codes: `AUTHENTICATION_REQUIRED`, `INVALID_SESSION`, `SESSION_EXPIRED`, `AUTH_PROVIDER_UNAVAILABLE`.

## Owner ID mapping

`ownerId = authenticatedUser.id` (Supabase UUID string) stored in existing **text** ownership columns.

No `chelcoach_users` table in this phase (lazy `gameplay_profiles` via `getOrCreate`).

No FK to `auth.users` yet.

Client-supplied `ownerId` fields remain stripped/ignored.

## Development session isolation

- Mint only when `mode=development_session` and `allowSessionMint`.
- Supabase mode never falls back to opaque Map sessions.
- Production mint remains blocked.

## Protected routes

**Public:** `/`, `/login`, `/signup`, `/forgot-password`, `/reset-password`, health.

**Frontend-guarded + backend-authed:** upload, identification, analysis status/report/cancel/confirm.

**Internal:** reconcile, cleanup, E2E hooks (unchanged secrets).

## CORS / CSRF

Bearer auth does not use cookie sessions. Mutations still require `X-ChelCoach-Requested-With` and configured `CORS_ORIGIN` allowlisting. No `*`.

## Session expiration

Supabase client auto-refresh. On unrecoverable 401, analysis status offers **Restore session** → `/login` with `state.from` preserving the durable analysis path.

## Password reset / redirects

`resetPasswordForEmail` redirect is same-origin `/reset-password` only. Open redirects rejected. Configure Supabase dashboard redirect allowlist for localhost (and later Vercel).

## Email confirmation

Signup may return without a session when confirmation is required. UI shows “check your email”. Do not change project email policy from the app.

## Verification

```bash
npm run verify:supabase-auth
CHELCOACH_LIVE_AUTH_VERIFY=1 npm run verify:supabase-auth
```

Live check creates prefixed `chelcoach.auth.test.*` users, verifies tokens, deletes those users. Does not delete unknown users.

## Rollback

1. Set `CHELCOACH_AUTH_MODE=development_session` locally.
2. Keep `CHELCOACH_PRODUCTION_AUTH_READY=false`.
3. Leave Supabase Auth users and Postgres data intact.
4. Do not drop auth schemas or reverse 10.1A migrations.

## Remaining risks / out of scope

- Analysis submission still disabled until media storage + provider readiness.
- No Supabase Storage / resumable uploads.
- No Vercel deploy / Cloudflare / Scotty HMAC.
- Anon key is public by design; security depends on Auth + backend authorization.
- Account deletion policy deferred (do not cascade-delete retained reports).
