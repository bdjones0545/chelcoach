# ChelCoach — Phase Status

Tracks the backend build-out (see [backend-plan.md](backend-plan.md) for the full roadmap).
The frontend product/conversion MVP is built; these phases turn the mocked flow into a real
backend one step at a time.

## ✅ Phase 0 — Contract & server skeleton (complete)

- **Shared Analysis Contract** ([`shared/analysisContract.ts`](../shared/analysisContract.ts)) —
  Zod schemas + inferred types for `scorecard`, `coachingMoments`, `filmRoom`, plus API
  envelopes and clip/error status enums. Single source of truth for the report shape.
- **Drizzle schema** ([`server/src/db/schema.ts`](../server/src/db/schema.ts)) — `sessions`,
  `clips`, `analysis_jobs`, `analyses` (report as typed `JSONB`). Staged, not yet used at runtime.
- **Express skeleton** — health endpoint + placeholder routes; lazy DB client so the server
  boots with no `DATABASE_URL`.

## ✅ Phase 1 — Static-report API loop (complete)

- **Deterministic sample report** ([`server/src/data/sampleReport.ts`](../server/src/data/sampleReport.ts))
  mirrors `src/data/mockData.ts` and is `analysisReportSchema.parse(...)`-validated at load
  (throws on drift).
- **In-memory clip store** + wired routes:
  - `POST /api/clips/:id/commit` → simulates an instantly-completed clip/job.
  - `GET /api/clips/:id` → clip status + report once `complete`.
  - `GET /api/clips/:id/analysis` → report alone once complete.
- **Smoke test** ([`server/src/smoke.ts`](../server/src/smoke.ts)) proves the loop end to end
  with no DB/storage/AI.

## ✅ Frontend backend-read flag (complete)

- **Feature flag** `VITE_USE_BACKEND_REPORTS` (default **off**). Off = current mock behavior,
  unchanged.
- **Read path** ([`src/lib/reportApi.ts`](../src/lib/reportApi.ts) +
  [`src/state/ReportContext.tsx`](../src/state/ReportContext.tsx)) — when on, commits a demo
  clip, polls until complete, normalizes (local-SVG fallbacks for omitted imagery), and feeds
  the same `scorecard` / `coachingMoments` / `filmRoom` the screens already render.
- Shared types imported **type-only** → `zod` is never bundled into the frontend.
- Graceful degradation: any backend failure silently keeps the identical-content mock report.

## ✅ Phase 2 — Real upload + object storage (complete)

Real video upload wired end to end, still with no ffmpeg/AI (a committed clip gets the static
sample report):

- **Object storage abstraction** ([`server/src/storage.ts`](../server/src/storage.ts)) — two
  backends: `memory` (default off-Replit; used by dev + CI) and `replit`
  (`@replit/object-storage`, GCS-backed, lazy-imported so CI never loads it). Select via
  `STORAGE_BACKEND`.
- **Upload flow** (server-proxied — Replit Object Storage has no presigned URLs):
  - `POST /api/uploads/init` → validates filename / MIME / size (server-authoritative
    `validateUploadMetadata`), creates a clip (`uploading`), returns `{ clipId, uploadUrl }`.
  - `PUT /api/clips/:id/file` → stores the raw bytes in object storage → clip `queued`.
  - `POST /api/clips/:id/commit` → finalizes → `complete` + static report.
- **Clip metadata** stored per clip: id, filename, MIME, declared + stored size, storage key,
  status, report. In-memory for now (Drizzle/Postgres in a later phase).
- **Frontend upload path** (behind `VITE_USE_BACKEND_REPORTS`, default off): the Upload screen
  really uploads the selected file with a progress bar, then transitions into the existing
  processing/report flow. Flag off = unchanged mock behavior.
- **Smoke test** extended to 9 checks: validation (415/413), full init → PUT → commit → report
  loop on the memory backend, and demo back-compat.

## ✅ Scotty Step 1 — Shared contracts + upload retention (complete)

- Versioned Scotty Zod contracts in [`shared/scotty/`](../shared/scotty/) (`SCOTTY_CONTRACT_VERSION = 1.0.0`).
- Upload / lease / retention schemas for up to **30-minute** gameplay videos.
- Cleanup-service foundation with processing-lease awareness (fake storage in CI).
- Drizzle tables prepared for `media_uploads`, leases, Scotty jobs/reports — **no raw video in Postgres**.
- Docs: [scotty-contracts.md](scotty-contracts.md).

## ✅ Scotty Step 2 — Upload sessions + gameplay profile (complete)

- Streamed upload path (`PUT /api/uploads/:id/content`) — no full-file Buffer on ingress.
- Gameplay profile defaults + per-upload context overrides (`saveAsDefaults` explicit).
- Trusted media inspection (ffprobe / fake in CI), duration + byte limits, media classification.
- Retention timestamps + abandoned pending expiration; ownership-scoped APIs.
- Docs: [scotty-upload-step2.md](scotty-upload-step2.md).

## ✅ Scotty Step 3 — Controlled-player confirmation (complete)

- Fixture identification adapter + confirmation frames/candidates persistence.
- Ownership-scoped confirmation APIs + authenticated frame delivery.
- `/player-confirmation` UI with bounding-box overlay, none-of-the-above, correction.
- Legacy buffered upload capped (demo-only); production Upload UI uses streamed sessions.
- Docs: [scotty-player-confirmation-step3.md](scotty-player-confirmation-step3.md).

## ⏭️ Next — Scotty Step 4

- Scotty transport / simulator wiring replacing the fixture identifier.
- **Still deferred:** Cloudflare tunnel, live Scotty VM, paid vision, auth & payments.

## What CI guarantees today

`.github/workflows/ci.yml` keeps the loop honest without external dependencies:

- frontend `npm run build` (type-check + Vite build),
- server `npm run typecheck`,
- server `npm run smoke` (contract loop).

No Postgres, object storage, ffmpeg, or AI keys are required.

## Repo status

- **GitHub repo created and pushed** — [`bdjones0545/chelcoach`](https://github.com/bdjones0545/chelcoach)
  (private), `main` in sync with `origin/main`.
- **CI passing** — the `CI` workflow runs on push/PR and is green.
- **`main` branch protection currently unavailable** — GitHub requires **Pro** (or a public
  repo) to enable branch protection / rulesets on a **private** repo for this account, so it
  could not be applied. Treated as a later account/billing item, **not** a blocker.
- **Manual rule for now:** all future feature work happens on **branches / pull requests** —
  no direct commits to `main`. Revisit automated protection once the account is on Pro (or the
  repo moves under a paid org).
