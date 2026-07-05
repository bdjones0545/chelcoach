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

## ⏭️ Next — Phase 2: Real upload + object storage

The next (riskier) phase introduces external systems, gated behind this repository-hardening step:

- `POST /api/uploads/init` → server-side validation + short-lived signed upload URL.
- Direct-to-object-storage upload; `POST /api/clips/:id/commit` verifies the object and
  enqueues a real job.
- Postgres-backed clip/job records replace the in-memory store; the Processing screen polls
  real status.
- **Still deferred:** ffmpeg frame extraction (Phase 3), AI analysis (Phase 4), auth & payments
  (later).

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
