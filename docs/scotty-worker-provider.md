# Scotty worker — the production analysis provider

`CHELCOACH_ANALYSIS_PROVIDER=scotty_worker` is the first provider that produces a real coaching
report. Everything before it (`fake`, `simulator`, the `scotty` HTTP skeleton, the
`direct_anthropic` stub) declared `canServeProductionTraffic=false`, so production analysis
submission had always been disabled by readiness.

## Shape

```text
POST /api/uploads/:id/analysis
  → ScottyWorkerProvider.submitAnalysis      (durable row in scotty_worker_jobs, status queued)
  → application job accepted (externalJobId = sw_…)

cron  GET /api/internal/analysis/worker  (every minute, CRON_SECRET)
  → runScottyWorkerBatch: claim (FOR UPDATE SKIP LOCKED, 5-minute lease)
      queued → extracting_frames   ffmpeg samples 6–24 JPEG frames over a signed URL
             → analyzing_gameplay  one vision-model call (structured output)
             → validating_report   assemble + bound to the report contract + quality gates
             → completed           report stored on the row
  → user poll / reconcile cron: provider.getJob → requires_report_fetch → getReport → persisted

Failures: retryable (rate limit, provider unavailable, sampling hiccup, schema miss) → back to
queued with exponential backoff until maxAttempts (3); permanent (deleted/expired media, missing
credentials) → failed immediately. Cancellation is honored before and during processing.
```

Nothing in the poll path touches the network: `getJob`/`getReport` read the row. The only
model calls happen inside the worker tick, under the tick's time budget
(`CHELCOACH_WORKER_BUDGET_MS`, default 240 s, below the 300 s function limit).

## What the model does and does not decide

The model receives sampled frames plus the confirmed controlled-player context and returns the
analysis pieces keyed by **frame index** and **mechanic id** (`server/src/ai/modelClient.ts`).
The application then:

- resolves frame indices to real timestamps and drops observations that cite a frame that was
  not sampled (disclosed in `qualityValidation.issues`);
- attaches control inputs from `controlsKnowledge.ts` — the model never writes button inputs;
  unknown mechanic ids are dropped; entries are `verified` only for the default Skill Stick
  mapping and `provisional` otherwise, and the report says so;
- enforces every bound in `shared/scotty/report.ts` (lengths, list sizes, faceoff arithmetic,
  platform consistency) before the report can be persisted;
- always appends a sampling disclosure, because events between frames are invisible.

Identification is the same pattern (`server/src/identification/claudeVisionIdentifier.ts`):
three evidence frames are extracted **first**, the model returns candidates with bounding boxes
by frame index, and boxes are tied to those exact frames. Several plausible skaters never
auto-accept.

## Media on Vercel

Both ffmpeg and ffprobe come from `@ffmpeg-installer` / `@ffprobe-installer` (static binaries,
platform packages as optional dependencies, included in the function via `includeFiles`). They
read Supabase Storage objects over a **short-lived signed URL** with range requests, so neither
inspection nor frame sampling downloads the video into the function's small `/tmp`. This is what
lets media inspection run inline in the per-minute cron (`CHELCOACH_INSPECTION_WORKER_INLINE=1`)
instead of on a dedicated VM.

## Operating

- Env inventory: `docs/vercel-production-environment.md`.
- Migration `0004_scotty_worker_jobs.sql` adds the enum value and table; apply with
  `npm run db:migrate` before enabling the provider.
- Readiness (`GET /api/admin/readiness`, owner-authenticated) shows
  `SCOTTY_WORKER_MODEL_KEY_MISSING` until `ANTHROPIC_API_KEY` is set.
- Model usage per job is recorded on the row (`model_usage`).
- Model override: `CHELCOACH_ANALYSIS_MODEL` (default `claude-opus-5`).
