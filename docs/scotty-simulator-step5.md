# Scotty Step 5 — Local Scotty lifecycle simulator

Step 5 adds an asynchronous local simulator behind the existing `ScottyProvider`
interface so ChelCoach can exercise the full analysis workflow before Cloudflare /
live Scotty are connected.

**Out of scope:** Cloudflare, live Scotty HTTP, production HMAC, full Drizzle job
lifecycle (Step 6), resilient polling/reload recovery (Step 7), final report UI.

## Architecture

```text
Application routes
  → AnalysisSubmissionService / AnalysisStatusService
  → ScottyProvider
  → SimulatorScottyProvider (elapsed-time lifecycle)
  → InMemorySimulatorJobRepository
```

Submission always returns `queued`. Lifecycle progression is derived from
`acceptedAt` + fake/system clock — no per-job `setTimeout` chains.

## Provider mode

| `CHELCOACH_ANALYSIS_PROVIDER` | Notes |
|---|---|
| `fake` (CI default) | Minimal accept/fail fixture |
| `simulator` | Full async lifecycle (local/dev) |
| `direct_anthropic` | Dev-only stub |
| `scotty` | Future HTTP transport |

Recommended local defaults:

```env
CHELCOACH_ANALYSIS_PROVIDER=simulator
CHELCOACH_SCOTTY_SIMULATOR_ENABLED=true
SCOTTY_SIMULATOR_DEFAULT_SCENARIO=auto
```

Production must not silently use the simulator. When `NODE_ENV=production`,
simulator mode requires `CHELCOACH_SCOTTY_SIMULATOR_ALLOW_IN_PRODUCTION=true`.

## Application routes

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/analysis/:applicationRequestId` | Status (ownership-scoped) |
| `GET` | `/api/analysis/:applicationRequestId/report` | Validated report |
| `POST` | `/api/analysis/:applicationRequestId/player-confirmation` | Remote confirmation |
| `POST` | `/api/analysis/:applicationRequestId/cancel` | Cancel job |

External job IDs are never sufficient alone — ownership is checked via the
submission record + upload owner.

## Persistence deferred to Step 6

Step 5 keeps:

- submission repository (request ↔ external job ↔ owner ↔ last status/sequence)
- in-memory simulator job repository

Still deferred:

- durable Postgres analysis-job tables
- callback processing
- reload recovery across server restarts in production

## Frontend

- `/analysis-status?requestId=…` — minimal truthful status UI (no percentages)
- polls using server `pollAfterMs`, stops on terminal / confirmation / unmount
- development-only label: **Local Scotty simulator**
