# ChelCoach — Vercel Auth environment configuration

Deployed Sign In requires **browser Vite variables at build time** and **server Supabase variables at runtime**. Changing `VITE_*` values does **not** update an already-built deployment — redeploy without cache after saving them.

## Root cause notes (deployed “Sign In does nothing”)

1. The Landing header **Sign In** control previously had no navigation handler (fixed in code).
2. Without `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` baked into the frontend build, the browser Auth client is not created. `/login` now shows a visible unavailable state instead of a silent failure.
3. Server Auth uses `SUPABASE_URL` / `SUPABASE_ANON_KEY` (not `VITE_*`). Both sides must be configured.

## Variable inventory

Set in **Vercel → Project → Settings → Environment Variables** for **Production** and **Preview** (Development optional).

### Browser-safe (embedded at `npm run build`)

| Variable | Classification | Notes |
| --- | --- | --- |
| `VITE_SUPABASE_URL` | Browser | Same project URL as `SUPABASE_URL` |
| `VITE_SUPABASE_ANON_KEY` | Browser | Same value as `SUPABASE_ANON_KEY` (public by design) |

### Server-only (Vercel Function runtime — never put in `VITE_*`)

| Variable | Classification |
| --- | --- |
| `SUPABASE_URL` | Server |
| `SUPABASE_ANON_KEY` | Server |
| `SUPABASE_SERVICE_ROLE_KEY` | Server (Storage/admin only — not normal user Auth) |
| `DATABASE_URL` | Server |

### Auth mode (server)

```env
CHELCOACH_AUTH_MODE=supabase_auth
CHELCOACH_PRODUCTION_AUTH_READY=true
```

### Storage (control plane; keep production media readiness off)

```env
CHELCOACH_MEDIA_STORAGE_MODE=supabase_storage
SUPABASE_GAMEPLAY_BUCKET=chelcoach-gameplay
SUPABASE_DERIVED_MEDIA_BUCKET=chelcoach-derived-media
CHELCOACH_PRODUCTION_MEDIA_STORAGE_READY=false
```

### Must remain disabled

```env
CHELCOACH_ANALYSIS_SUBMISSION_ENABLED=false
CHELCOACH_SCOTTIE_ENABLED=false
```

Also configure `CORS_ORIGIN` to the production Vercel URL (and approved previews) so credentialed API calls are allowed.

Do **not** put secrets in `vercel.json`. Do **not** commit real values.

## Vite build-time rule

* `VITE_*` are inlined during `npm run build`.
* Adding or changing them in the Vercel dashboard requires a **new deployment**.
* Redeploy the latest `main` **without build cache**.

## Supabase dashboard — URL configuration

```text
Authentication → URL Configuration
```

* **Site URL:** current Vercel production URL (or final ChelCoach domain).
* **Redirect URLs:** only approved entries, for example:
  * `https://<production-host>/login`
  * `https://<production-host>/reset-password`
  * `http://localhost:5173/login` (local)
  * approved preview hosts if needed

The app uses fixed same-origin paths (`/login`, `/reset-password`) — not open redirects.

## Operator redeploy checklist

1. Open Vercel → ChelCoach project.
2. **Settings → Environment Variables**.
3. Add browser-safe: `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`.
4. Add server-only: `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `DATABASE_URL`.
5. Add `CHELCOACH_AUTH_MODE=supabase_auth` and `CHELCOACH_PRODUCTION_AUTH_READY=true`.
6. Preserve media/analysis/Scotty disabled flags above.
7. Save for Production (+ Preview).
8. **Deployments → Redeploy latest `main` → without build cache**.
9. Test `/login` and `/signup`.
10. Confirm session + protected API Bearer access.
11. Confirm analysis remains disabled (`/api/health/readiness`).

## API routing

* `/api/health` and `/api/health/readiness` must return JSON (not SPA HTML).
* `vercel.json` rewrites `/api/*` to the API function before SPA fallback.
