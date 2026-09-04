# ChelCoach — Vercel deployment

## Package layout

ChelCoach is **not** a single npm package. It contains three independent projects:

| Project | Path | Role |
| --- | --- | --- |
| Frontend | `/` (root) | Vite + React SPA (`npm run build` → `dist/`) |
| Shared contracts | `shared/` | Zod schemas / types (`zod` lives here) |
| Server | `server/` | Express API used by `api/index.ts` |

The serverless entry is `api/index.ts` → `server/src/vercelApp.ts` (no `listen()` on Vercel).

## Why the first production deploy failed

Vercel targeted obsolete `main` (`3f6c0e2`) and ran a **root-only** install.

On that commit:

* root `package.json` does **not** declare `zod`
* `shared/package.json` **does** declare `zod`
* `tsc -b` type-checks `shared/analysisContract.ts` via imports from `src/`
* without `shared/node_modules`, TypeScript reports `Cannot find module 'zod'`
* collapsed contract types then surface as secondary `reportApi.ts` implicit-`any` errors

Those `reportApi.ts` lines are not the root cause. Installing `shared` (and `server` for the API function) resolves them.

## Repository-controlled install

Committed install entrypoints:

* `scripts/install-all.sh`
* `vercel.json` → `installCommand`
* root script `npm run install:all`

Equivalent command:

```bash
npm ci && npm --prefix shared ci && npm --prefix server ci
```

Do **not** rely on a dashboard-only install override. Keep `installCommand` in `vercel.json`.

## Project settings (operator checklist)

| Setting | Value |
| --- | --- |
| Framework preset | **Other** (`framework: null` in `vercel.json`) |
| Root directory | `.` |
| Install command | repository-controlled (`scripts/install-all.sh` via `vercel.json`) |
| Build command | `npm run build` |
| Output directory | `dist` |
| Production branch | `main` |

SPA rewrites must not swallow `/api/*` (see `vercel.json` rewrites).

## Auth environment

Browser Auth requires `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` at **build** time.
Server Auth requires `SUPABASE_URL` / `SUPABASE_ANON_KEY` (and related) at **runtime**.

See `docs/vercel-auth-environment.md` for the full inventory, Supabase redirect URLs, and redeploy steps.

## Local clean-build simulation (Vercel-like)

```bash
rm -rf node_modules shared/node_modules server/node_modules
bash scripts/install-all.sh
npm run build
```

Optional checks:

```bash
npm run lint
npm test
npm --prefix shared test
npm --prefix server run typecheck
npm --prefix server test
npm run audit:bundle
npm run audit:security-scan
```

Do not run the Express server during build. Do not call `listen()` under `VERCEL`.

## Redeploy after merge

1. Confirm the multipackage-install PR is merged into `main` (and that PRs through the Vercel/API stack — at least through media-inspection / PR #21 — are already on `main`).
2. Confirm GitHub `main` includes `api/index.ts`, `vercel.json`, and `server/src/vercelApp.ts`.
3. Open the Vercel project.
4. Confirm Production Branch is `main`.
5. Confirm Framework Preset is **Other**.
6. Confirm Root Directory is `.`.
7. Use the committed install/build configuration (do not override away from `install-all`).
8. Redeploy the latest `main` commit.
9. Select **Redeploy without build cache**.
10. Confirm the deployment log shows installation of root, shared, and server dependencies (`[install-all]` lines).
11. Confirm `npm run build` passes.
12. Keep analysis and Scotty readiness flags disabled (`CHELCOACH_ANALYSIS_SUBMISSION_ENABLED=false`, `CHELCOACH_SCOTTIE_ENABLED=false`). Keep `CHELCOACH_PRODUCTION_MEDIA_STORAGE_READY=false` until the media worker is signed off.

## Out of scope

* Cloudflare tunnel / Workers
* Enabling Scotty or production analysis
* Changing product behavior
