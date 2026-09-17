# ChelCoach

**Film-room coaching for EA SPORTS NHL players — upload a clip of your own gameplay, confirm
which skater you controlled, and get an evidence-based coaching report.**

ChelCoach samples frames from a gameplay recording, identifies the controlled skater, and
sends the frames to the Scottie analysis gateway. The report that comes back is scoped to
that skater: frame-cited observations, strengths, priority improvements, strategy notes,
practice drills, and explicit uncertainty disclosures. It never narrates action between
sampled frames and never invents statistics.

## The product flow

```
Landing → Sign up / Sign in → Upload (clip + game + gameplay profile)
        → Player confirmation → Analysis status → Report
   /        /signup /login       /upload            /player-confirmation   /analysis/:id   /analysis/:id/report
```

Every step after sign-in talks to the API. There is no client-side fallback: if the server
reports analysis closed (`GET /api/health/readiness` → `analysisSubmission: "disabled"`), the
Upload screen says so and the submit button stays disabled.

A separate **sample report** (`/scorecard`, `/film-preview`, `/paywall`, `/film-room`) is
reachable from "View Demo Report" on the landing page. Every screen in it carries a
"Sample report — example content, not your gameplay" banner. The paywall in that loop is a
preview of what membership will include; there is no billing yet and the copy says so.

## Game support

`shared/scotty/games.ts` (mirrored for the UI in `src/data/gameCatalog.ts`) is the catalog of
EA NHL titles the Upload screen offers and which of them are accepted. "Supported" is a
product flag: the coaching pipeline is not title-specific, and the gateway's per-title
control/strategy registries are disabled in production. The catalog is newest-first and the
Upload screen defaults to the first entry; `src/data/gameCatalog.test.ts` keeps the mirror equal.

The report's **Chel Rating** is the provider's rubric estimate (`performanceEstimate` in
`shared/scotty/report.ts`): six 0–100 metrics folded into a 0–1000 number, carried with its
basis (frame count, duration, rubric version) and confidence, and always shown as an estimate.
A flat rubric (every metric identical — what the gateway emits when the model scored nothing)
is withheld rather than shown.

## Architecture

| Piece | Where | Notes |
| --- | --- | --- |
| Frontend | `src/` — React 19, Vite, TypeScript, Tailwind | Static build served by Vercel |
| API | `server/` — Express 5 on Vercel functions via `api/index.ts` | Own npm project, runs with `tsx` |
| Shared contract | `shared/scotty/` — Zod schemas | Upload, identification, job, report shapes |
| Auth | Supabase Auth, verified server-side (`server/src/auth/`) | App tables have RLS on with no policies; the API uses its own role |
| Storage | Supabase Storage (TUS uploads) | `CHELCOACH_MEDIA_STORAGE_MODE` |
| Database | Postgres via Drizzle (`server/drizzle/`) | Migrations 0000–0005 on main (0006 in PR #36) |
| Analysis | Provider `scotty` → Scottie gateway on orgo-desktop | source `services/scottie-gateway/`, deploy `ops/orgo-desktop/scottie/deploy.sh` |
| Scheduling | Vercel crons in `vercel.json` | media cleanup, storage reconcile, inspection worker, analysis worker |

Authorization is enforced by the API. Client-side route guards (`RequireAuth`) are UX only.

## Running locally

Node 22, npm.

```bash
bash scripts/install-all.sh      # root + shared + server
npm run dev                      # Vite → http://localhost:5173
cd server && npm run dev         # API → http://localhost:3001 (memory persistence, simulator provider)
```

Copy `.env.example` → `.env.local` (frontend) and `server/.env.example` → `server/.env`
(backend) to override defaults. Without Supabase variables the API runs
`CHELCOACH_AUTH_MODE=development_session`; without `DATABASE_URL` it keeps state in memory.

### Checks

```bash
npm test                 # frontend (vitest)
npm run test:shared      # contract tests
npm run test:server      # API unit tests
npm run test:e2e         # Playwright journeys (needs Postgres; see below)
npm run build && npm run lint
```

Durable E2E (the golden path needs Postgres):

```bash
CHELCOACH_E2E_DATABASE_URL=postgresql://chelcoach:chelcoach@127.0.0.1:5432/chelcoach_test npm run test:e2e
```

CI (`.github/workflows/ci.yml`) runs all of the above against a Postgres service.

## Production

- Vercel project `train-efficiency/chelcoach` → chelcoach.io. Environment reference:
  `docs/vercel-production-environment.md`; writer: `scripts/configure-vercel-env.sh`.
- Health: `GET /api/health` (liveness). Capability: `GET /api/health/readiness` — analysis
  submission is only enabled when auth, durable storage, media storage, the provider, and
  `CHELCOACH_ANALYSIS_SUBMISSION_ENABLED=1` are all in place.
- Gateway: `ops/orgo-desktop/scottie/apply.sh` installs keys/provider config on the VM;
  `ops/orgo-desktop/scottie/deploy.sh` ships `services/scottie-gateway/` and restarts it.

## Docs

`docs/` holds the step-by-step build records (`scotty-*.md`, `supabase-*.md`,
`vercel-*.md`). `docs/phase-status.md` is the historical build log.
