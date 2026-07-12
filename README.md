# ChelCoach

**AI-style gameplay coaching for NHL video-game players — upload a clip, get a coach-grade scorecard, and unlock a full film-room breakdown.**

ChelCoach turns a single uploaded game clip into a polished coaching experience: a free
**Chel Rating** scorecard, a preview of locked "film-room" insights, and a paywall that
unlocks the full AI breakdown. It is built as a conversion-first product MVP for competitive
NHL ("Chel") players who want to understand *why* they win and lose — in plain hockey
language — and turn that into a plan for their next game.

> **MVP status.** This is a product-experience MVP. There is **no real AI, no video
> processing, no payments, and no auth** yet. Analysis is polished mock data
> ([`src/data/mockData.ts`](src/data/mockData.ts)); the backend serves a deterministic,
> contract-validated static report matching that data. The backend is being built out phase
> by phase toward real uploads and analysis — see [docs/phase-status.md](docs/phase-status.md).

---

## Overview

Competitive NHL players get a final score and some box-score stats, but no coaching — no
explanation of the reads they missed, the coverage that broke down, or what to practice next.
ChelCoach reframes a gameplay clip as a coach would: a graded skill scorecard, tagged
coaching moments on a timeline, and an actionable next-game plan.

The app is organized around a single **upload → scorecard → unlock** conversion flow:

```
Landing → Upload → AI Processing → Free Scorecard → Locked Film Preview → Paywall → Full Film Room
   /       /upload   /processing     /scorecard        /film-preview       /paywall     /film-room
```

"Start Free Trial" on the paywall flips a mock premium flag
([`src/state/PremiumContext.tsx`](src/state/PremiumContext.tsx)) and routes the player into
the unlocked Full Film Room. Routing is defined in [`src/App.tsx`](src/App.tsx).

**Who it's for:** competitive EA Sports NHL players who want coach-style feedback on their
own gameplay, and the team building/validating that product experience.

---

## Features

Every feature below is driven by real content and screens in the codebase (`src/screens/*`,
`src/data/mockData.ts`, `shared/analysisContract.ts`).

- **Free Gameplay Scorecard** — a 0–1000 **Chel Rating**, overall letter grade, percentile,
  and per-skill grades (Offensive IQ, Defense, Passing, Positioning, Decision Making, Puck
  Management), each with a semantic tone (good / warn / bad) and a coaching note. Highlights
  the player's biggest strength and biggest weakness.
- **AI Processing screen** — a staged "review" animation (positioning → defensive coverage →
  offensive decisions → building your report) that sets up the reveal.
- **Locked Film Preview** — tagged coaching moments (Great Play, Missed Opportunity,
  Defensive Breakdown) with timestamp, period, and an open teaser; the full breakdown is
  gated behind the paywall.
- **Outcome-based Paywall** — benefit cards framed around results the player gets (know what
  cost you the game, read the ice, rewatch mistakes on film, a weekly focus, personalized
  drills, unlimited uploads).
- **Full Film Room** — interactive timeline with tone-coded markers, coach commentary,
  strengths vs. mistakes, highest-impact adjustment, next-game focus, a weekly skill-focus
  drill plan, a game-summary stat line, and impact meters.
- **Upload validation** — accepts MP4 / MOV up to 2 GB, with player-friendly error copy for
  unsupported and oversized files; the same rules are enforced server-side via a shared
  contract.
- **Shared Analysis Contract** — Zod schemas + inferred types in
  [`shared/analysisContract.ts`](shared/analysisContract.ts) are the single source of truth
  for the report shape, so the frontend can consume either local mock data or the backend
  API with **zero shape drift**.
- **Optional live backend read path** — behind a feature flag, the UI commits a demo clip,
  polls until complete, and renders the backend's report instead of local mock data.
- **"Pro Ice Analytics" design system** — a glassmorphism UI (glass panels, blur, glows,
  animations) with design tokens in [`tailwind.config.js`](tailwind.config.js); self-hosted
  fonts and icons so there are no network dependencies.

---

## Tech Stack

**Frontend**

- React 19 + [Vite](https://vite.dev/) + TypeScript
- React Router v6
- Tailwind CSS v3 (+ PostCSS, autoprefixer)
- Self-hosted assets: `@fontsource` (Oswald / Inter / JetBrains Mono) and `material-symbols`
  — no runtime network dependencies
- [oxlint](https://oxc.rs/) for linting

**Backend** ([`server/`](server/) — its own npm project)

- Node 22, Express 5, TypeScript (run directly via [`tsx`](https://tsx.is/), no build step)
- [Zod](https://zod.dev/) validation via the shared contract
- [Drizzle ORM](https://orm.drizzle.team/) + `pg` (Postgres schema staged for a later phase — **not required to run today**)
- `@replit/object-storage` (used only when running on Replit; local/CI use an in-memory store)

**Shared** ([`shared/`](shared/)) — the Analysis Contract (Zod schemas + inferred types).

**Tooling:** npm (package-lock.json), `replit.nix` (Nix env, Node 22), GitHub Actions CI.

> The frontend, backend, and shared contract are **three isolated npm projects**. The
> frontend build never compiles `server/` or `shared/`, so it always stays green.

---

## Getting Started

### Prerequisites

- **Node.js 22** (matches `replit.nix`)
- **npm** (repository uses `package-lock.json`)
- No database, object storage, ffmpeg, or AI keys are required to run the app — it runs on
  mock data out of the box.

### Frontend (from repo root)

```bash
npm install
npm run dev        # start Vite dev server → http://localhost:5173
npm run build      # tsc -b && vite build (type-check + production build)
npm run preview    # preview the production build locally
npm run lint       # oxlint
```

### Shared contract

Install once so the frontend and server can resolve the shared types:

```bash
cd shared && npm install
```

### Backend (optional — only for the live read/upload path)

```bash
cd server && npm install
npm run dev        # tsx watch → http://localhost:3001
npm run start      # run the server once (tsx, no compile step)
npm run typecheck  # tsc --noEmit
npm run smoke      # boot on an ephemeral port and assert the contract loop end to end
```

Health check: `curl http://localhost:3001/api/health`.

### Trying the live backend read path

By default the UI runs entirely on local mock data. To have it read the report from the
backend instead:

1. Start the backend (`cd server && npm run dev`).
2. In the frontend, copy `.env.example` → `.env.local` and set `VITE_USE_BACKEND_REPORTS=true`.
3. Restart the Vite dev server.

With the flag off, behavior is unchanged. Any backend failure gracefully falls back to the
identical-content mock report.

### Environment variables

All variables are **optional** — the app runs on mock data with none set. Copy
`.env.example` → `.env.local` (frontend) or `server/.env.example` → `server/.env` (backend)
to override.

| Var | Scope | Default | Purpose |
|---|---|---|---|
| `VITE_USE_BACKEND_REPORTS` | frontend | `false` | `true` reads the report from the backend API instead of local mock data. |
| `VITE_API_BASE_URL` | frontend | `http://localhost:3001` | Backend base URL (used only when the flag is on). |
| `PORT` | backend | `3001` | API server port. |
| `CORS_ORIGIN` | backend | allow all (dev) | Comma-separated allowed origins. |
| `STORAGE_BACKEND` | backend | auto | Object storage backend: `memory` \| `replit`. Auto = `replit` on Replit (`REPL_ID` present), else `memory`. Local dev + CI use `memory`. |
| `DATABASE_URL` | backend | — | Postgres connection string. **Not required yet** — used from the database phase onward. |

> `ANTHROPIC_API_KEY` and other keys are reserved for later phases — do not set them yet.

---

## Project Structure

```
chelcoach/
├─ src/                        Frontend — React 19 + Vite + TypeScript
│  ├─ App.tsx                  Route table for the conversion flow
│  ├─ main.tsx                 App entry
│  ├─ screens/                 One file per screen: Landing, Upload, Processing,
│  │                           Scorecard, FilmPreview, Paywall, FilmRoom
│  ├─ components/              Reusable UI (Button, GlassPanel, MetricCard,
│  │                           CoachingMomentCard, TopAppBar, BottomNav, …)
│  ├─ state/                   React contexts: Premium, Analysis, Report (mock vs. API source)
│  ├─ lib/reportApi.ts         Backend read path (behind the feature flag)
│  ├─ data/mockData.ts         All placeholder analysis content + upload rules/UX copy
│  ├─ assets/                  Local SVG imagery (rink stills, dashboard, avatar)
│  └─ index.css                Design-system utilities (glass, blur, glows, animations)
│
├─ shared/                     Shared Analysis Contract (own npm project)
│  └─ analysisContract.ts      Zod schemas + inferred types — the report's source of truth
│
├─ server/                     Backend API — Express 5 + TypeScript (own npm project)
│  ├─ src/
│  │  ├─ index.ts / app.ts     Server entry + Express app (CORS, routers, error handling)
│  │  ├─ routes/               health.ts, clips.ts, uploads.ts
│  │  ├─ data/sampleReport.ts  Deterministic report (mirrors mockData; contract-validated at load)
│  │  ├─ store.ts              In-memory clip store
│  │  ├─ storage.ts            Object-storage abstraction (memory | replit)
│  │  ├─ db/                   Drizzle schema + lazy Postgres client (staged for a later phase)
│  │  ├─ contract.ts           Re-export of the shared contract
│  │  └─ smoke.ts              Dependency-free smoke test of the full loop
│  └─ drizzle.config.ts
│
├─ public/                     Static assets (favicon.svg, icons.svg)
├─ docs/                       backend-plan.md, backend-setup-replit.md, phase-status.md
├─ .github/workflows/ci.yml    CI: frontend build + server typecheck + smoke
├─ replit.nix                  Nix environment (Node 22)
├─ tailwind.config.js          "Pro Ice Analytics" design tokens
├─ vite.config.ts
└─ index.html
```

### Backend API surface (current)

The backend runs a deterministic upload → report loop against the static sample report (no
ffmpeg/AI yet):

- `GET  /api/health` — service health.
- `POST /api/uploads/init` — validate filename / MIME / size, create a clip, return `{ clipId, uploadUrl }`.
- `PUT  /api/clips/:id/file` — store the raw bytes in object storage.
- `POST /api/clips/:id/commit` — finalize the clip → `complete` + report.
- `GET  /api/clips/:id` — clip status, plus the report once `complete`.
- `GET  /api/clips/:id/analysis` — the report alone once complete.

---

## Deployment

The project targets **[Replit](https://replit.com/)** (per `replit.nix` and
[docs/backend-setup-replit.md](docs/backend-setup-replit.md)):

- The **Vite frontend** deploys as a static build and calls the API base URL.
- The **API** targets a Replit **Reserved VM** (always-on, for the eventual background job
  poller), run with `cd server && npm run start` (runs via `tsx`, no compile step).
- **Object Storage** uses the `replit` backend automatically on Replit (`REPL_ID` present);
  local dev and CI use the in-memory backend, so no paid service is needed.
- `ffmpeg` is intentionally commented out in `replit.nix` until frame extraction is
  implemented.

---

## Roadmap / Phase Status

The frontend product/conversion MVP is built. The backend is being turned from a mocked flow
into a real one, phase by phase:

- ✅ **Phase 0** — Shared Analysis Contract + Drizzle schema + Express skeleton.
- ✅ **Phase 1** — Deterministic static-report API loop (commit → poll → report).
- ✅ **Frontend read flag** — UI can consume the backend report with zero shape drift.
- ✅ **Phase 2** — Real video upload + object storage (init → PUT bytes → commit); report is
  still the static sample.
- ⏭️ **Phase 3 (next)** — ffmpeg frame extraction (posters + thumbnails).
- ⏭️ **Later** — AI analysis, Postgres persistence, auth, and payments.

Full detail: [docs/phase-status.md](docs/phase-status.md) ·
[docs/backend-plan.md](docs/backend-plan.md) ·
[docs/backend-setup-replit.md](docs/backend-setup-replit.md).

---

## Continuous Integration

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs on push and pull request and
checks: frontend `npm run build`, and server `typecheck` + `smoke`. It requires **no**
Postgres, object storage, ffmpeg, or AI keys.
