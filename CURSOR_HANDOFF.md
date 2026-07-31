# ChelCoach — Cursor Handoff

Practical guide for continuing ChelCoach development in Cursor. For the full readiness
audit, see `chelcoach-cursor-migration-audit.md` (kept outside the repo).

---

## 1. Migration status

**CURSOR TRANSFER READY.** The repository builds, type-checks, smoke-tests, and lints green
on a stock macOS + Node 22 machine with no Replit runtime. The Replit-specific portability
fixes are complete:

- `replit.nix` removed (its only active pin, Node 22, is now covered by `.nvmrc`, package
  `engines`, and CI).
- Node 22 guardrails added (`.nvmrc` + `engines` on every installable package).
- Toolchain drift reconciled: TypeScript unified to `~6.0.2` (server was `5.9.3`);
  `@types/node` unified to `^22.x` to match the Node 22 runtime (frontend was `^24`).

The `@replit/object-storage` dependency is intentionally kept — it is lazy-imported and only
used when running on Replit; everywhere else the backend uses an in-memory store (see §9).

## 2. Node & package-manager requirements

- **Node:** 22 (`>=22 <23`). Run `nvm use` (reads `.nvmrc`).
- **Package manager:** npm (lockfiles are `package-lock.json`; CI uses `npm ci`).
- Three **independent** npm projects — no workspace tool. Install each separately.

## 3. Repository structure

```
chelcoach/
  src/         Frontend — React 19 + Vite 8 + TypeScript 6 + Tailwind 3 + React Router 6
  shared/      Analysis Contract — Zod schemas + inferred types (single source of truth)
  server/      Backend — Express 5 + TypeScript (run via tsx), Zod, Drizzle (staged), pg
  docs/        backend-plan.md · phase-status.md · backend-setup-replit.md
  .github/workflows/ci.yml
  .nvmrc       Node 22
```

## 4. Installation

```bash
nvm use                      # Node 22
npm install                  # frontend (repo root)
cd shared  && npm install    # shared contract (install so types resolve)
cd ../server && npm install  # backend
```

CI-style reproducible install: `npm ci` in `shared/`, root, then `server/`.

## 5. Local development

```bash
# Frontend  → http://localhost:5173
npm run dev

# Backend   → http://localhost:3001  (from server/)
cd server && npm run dev

# Live backend read/upload path (optional): set VITE_USE_BACKEND_REPORTS=true in
# .env.local, run the server, restart Vite. Flag off = pure mock behavior, unchanged.
```

## 6. Validation (the full quality gate)

```bash
npm run build                 # frontend: tsc -b + vite build
npm run lint                  # frontend: oxlint
cd server && npm run typecheck # tsc --noEmit
cd server && npm run smoke     # boots app on ephemeral port, asserts contract loop (13 checks)
```

`server`'s `build` script is an alias for `typecheck` (`tsc --noEmit`) — the server runs via
`tsx`, so there is no compiled server output.

## 7. Environment variables (all optional — app boots with none set)

| Var | Scope | Default | Purpose |
|---|---|---|---|
| `VITE_USE_BACKEND_REPORTS` | frontend | `false` | `true` reads the report from the backend instead of local mock data. |
| `VITE_API_BASE_URL` | frontend | `http://localhost:3001` | Backend base URL (only used when the flag is on). |
| `PORT` | backend | `3001` | API server port. |
| `CORS_ORIGIN` | backend | allow-all (dev) | Comma-separated allowed origins. **Set explicitly in production.** |
| `STORAGE_BACKEND` | backend | auto | `memory` \| `replit`. Auto = `replit` on Replit (`REPL_ID` set), else `memory`. |
| `DATABASE_URL` | backend | — | Postgres URL. **Not used at runtime yet** (schema staged only). |

Copy `.env.example` → `.env.local` (frontend) or `server/.env.example` → `server/.env` (backend).

## 8. Optional vs. required external services

**Required to run/build/test:** none. **All external services are optional / deferred:**

| Service | Status |
|---|---|
| PostgreSQL (`DATABASE_URL`) | Optional — Drizzle schema staged, not wired at runtime. |
| Object storage | Optional — in-memory backend by default. |
| ffmpeg | Not used yet (Phase 3, frame extraction). |
| Anthropic AI (`ANTHROPIC_API_KEY`) | Not used yet (Phase 4, real analysis). |

## 9. Replit compatibility that remains (intentional)

- `@replit/object-storage` (server dependency) is **lazy-imported** — loaded only when the
  `replit` storage backend is selected. CI and local dev never touch it.
- `server/src/storage.ts` selects the backend at runtime: `STORAGE_BACKEND` if set, else
  `replit` when `REPL_ID` is present, otherwise **`memory`** (an in-process `Map`). Off Replit
  it always falls back to memory, so uploads work locally with zero configuration.
- A few source comments still reference Replit deployment / `docs/backend-setup-replit.md`.
  These are documentation pointers, not runtime coupling.

**In-memory fallback behavior:** with the memory backend, uploaded bytes and clip metadata
live in process memory and **reset on server restart**. This is expected for the current MVP.

## 10. Known limitations (current MVP)

- **No real AI / video processing** — a committed clip returns a deterministic sample report.
- **No persistence** — in-memory clip store; state resets on restart.
- **No auth, no payments** — `PremiumContext` is a mock unlock flag.
- **No frontend tests** — backend has a 13-check smoke test; the frontend has none.
- **npm audit warnings** — pre-existing transitive advisories in the app-framework tree
  (3 root / 12 server). Not introduced by this migration; left untouched (out of scope).
- Bleeding-edge majors (Vite 8, React 19, TS 6, Express 5) — all verified building here.

## 11. Deferred production work (future phases, not part of this handoff)

- **Phase 3** — ffmpeg frame extraction (`ffmpeg` becomes a required *system* dependency;
  previously noted in the now-removed `replit.nix`). Install ffmpeg in the dev/deploy
  environment when this phase begins.
- **Phase 4** — real Claude vision analysis (structured output against the Analysis Contract).
- **Later** — Postgres persistence (wire the staged Drizzle schema), auth + ownership scoping,
  Stripe payments, rate limiting / quotas, a production object-storage backend (S3/GCS),
  and CORS lockdown.

## 12. Recommended first task in Cursor

**Verify the environment, then add frontend test coverage.** First confirm the gate is green
(`nvm use`; install all three; run §6). Then introduce Vitest + React Testing Library and cover
the highest-risk untested code — `src/lib/reportApi.ts` (upload/init/poll/normalize) and the
mock↔contract parity between `src/data/mockData.ts` and `shared/analysisContract.ts`. This is
additive, low-risk, and closes the single biggest gap the audit found — without touching
application behavior.

---

### Scope note

This handoff covers **migration-complete** portability work only. It does not implement tests,
auth, payments, persistence, real AI, or storage replacement — those remain deferred production
work (§11).
