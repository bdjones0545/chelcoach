# ChelCoach

AI gameplay coaching for NHL video-game players. Upload a clip, get a coach-style
**Chel Rating** scorecard, preview locked film-room insights, and unlock the full
AI breakdown.

> **MVP note:** This is a product-experience MVP. There is **no real AI, no video
> processing, no payments, and no auth** yet. Analysis is polished mock data
> ([`src/data/mockData.ts`](src/data/mockData.ts)); the backend currently serves a
> deterministic static report matching that data. See [docs/phase-status.md](docs/phase-status.md).

## Conversion flow

```
Landing → Upload → AI Processing → Free Scorecard → Locked Film Preview → Paywall → Full Film Room
   /      /upload   /processing     /scorecard        /film-preview      /paywall     /film-room
```

"Start Free Trial" on the paywall flips a mock premium flag
([`src/state/PremiumContext.tsx`](src/state/PremiumContext.tsx)) and routes into the
unlocked Full Film Room.

## Repository structure

Three isolated npm projects. The frontend build never compiles `server/` or `shared/`.

```
chelcoach/
  src/                     Frontend — React 19 + Vite + TypeScript
    components/            Reusable UI (Button, GlassPanel, MetricCard, CoachingMomentCard, …)
    screens/               One file per screen in the conversion flow
    state/                 PremiumContext, AnalysisContext, ReportContext (mock/API report source)
    lib/reportApi.ts       Backend read path (behind a feature flag)
    data/mockData.ts       All placeholder analysis content
    assets/                Local SVG imagery (rink stills, dashboard, avatar)
    index.css              Design-system utilities (glass, blur, glows, animations)
  shared/                  Shared Analysis Contract — Zod schemas + inferred types
    analysisContract.ts
  server/                  Backend API — Express + TypeScript (Drizzle schema staged, not wired)
    src/
      index.ts app.ts      Server entry + Express app
      routes/              health + clip/analysis routes
      data/sampleReport.ts Deterministic report (mirrors mockData, contract-validated at load)
      store.ts             In-memory clip store (Phase 1 static loop)
      db/                  Drizzle schema + lazy client (used from Phase 2)
      smoke.ts             Dependency-free smoke test
  docs/                    Backend plan, Replit setup, phase status
  .github/workflows/ci.yml CI: frontend build + server typecheck + smoke
```

Design system ("Pro Ice Analytics") tokens live in `tailwind.config.js`; the shared
Analysis Contract in `shared/` is the single source of truth for the report shape.

## Tech

- **Frontend:** React 19, Vite, TypeScript, Tailwind CSS v3, React Router v6. Self-hosted
  fonts/icons (no network deps): `@fontsource` (Oswald / Inter / JetBrains Mono) +
  `material-symbols`.
- **Backend:** Node 22, Express 5, TypeScript (run via `tsx`), Zod, Drizzle (Postgres,
  staged for Phase 2). No database needed to boot or test today.

## Environment variables

All optional — the app runs on mock data with none set. Copy `.env.example` →
`.env.local` (frontend) or `server/.env` (backend) to override.

| Var | Scope | Default | Purpose |
|---|---|---|---|
| `VITE_USE_BACKEND_REPORTS` | frontend | `false` | `true` reads the report from the backend API instead of local mock data. |
| `VITE_API_BASE_URL` | frontend | `http://localhost:3001` | Backend base URL (used only when the flag is on). |
| `PORT` | backend | `3001` | API server port. |
| `CORS_ORIGIN` | backend | allow all (dev) | Comma-separated allowed origins. |
| `DATABASE_URL` | backend | — | Postgres URL. **Not required yet** (Phase 2). |

## Local development

Each project installs independently.

```bash
# Frontend (from repo root)
npm install
npm run dev        # http://localhost:5173
npm run build      # tsc -b && vite build (type-check + production build)

# Shared contract (needed so frontend/server can resolve the shared types)
cd shared && npm install

# Backend
cd server && npm install
npm run dev        # http://localhost:3001  (tsx watch)
npm run typecheck  # tsc --noEmit
npm run smoke      # boots app on an ephemeral port, asserts the contract loop
```

To try the live read path: run the server, set `VITE_USE_BACKEND_REPORTS=true` in
`.env.local`, and restart the Vite dev server. With the flag off, behavior is unchanged.

## Current phase status

- ✅ **Phase 0** — Shared Analysis Contract + Drizzle schema + Express skeleton.
- ✅ **Phase 1** — Deterministic static-report API loop (`commit` → poll → report).
- ✅ **Frontend read flag** — UI can consume the backend report with zero shape drift.
- ⏭️ **Next (Phase 2)** — Real upload + object storage.

Full detail: [docs/phase-status.md](docs/phase-status.md) ·
[docs/backend-plan.md](docs/backend-plan.md) · [docs/backend-setup-replit.md](docs/backend-setup-replit.md)

## CI

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs on push/PR and checks: frontend
`npm run build`, and server `typecheck` + `smoke`. It needs **no** Postgres, storage,
ffmpeg, or AI keys.
