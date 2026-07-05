# ChelCoach — Backend Implementation Plan (v1)

Goal: turn the mocked MVP into a real **upload → AI analysis → Film Room** product with the
smallest production backend that works. Narrow scope: **NHL gameplay only, one clip at a time.**
No social, no marketplace, no multi-game. Auth/payments are planned but come *after* the first
real analysis renders in the existing Film Room UI.

---

## 0. Guiding principle — the Analysis Contract

The frontend already renders a fixed data shape (`src/data/mockData.ts`): `scorecard`,
`coachingMoments[]`, and `filmRoom{}`. **That shape is the contract.** The backend's entire job
is to produce a JSON `analysis` object matching it, per clip. If we hold that contract, the UI
barely changes — we swap the imported mock for a fetched object.

So the first real deliverable is not "a server" — it's: *one uploaded clip produces one contract-
shaped `analysis` row that the Film Room reads.* Everything below serves that.

---

## Recommended stack (Replit-native, matches existing ecosystem)

| Concern | Choice | Why |
|---|---|---|
| Runtime | **Node 22 + TypeScript** | Same language as the frontend; shared types. |
| HTTP framework | **Express** | Boring, stable, well-understood. |
| DB | **PostgreSQL** (Replit Postgres / Neon) | Relational + `JSONB` for the report blob. |
| ORM/migrations | **Drizzle** | Type-safe, lightweight, matches sibling projects. |
| Object storage | **Replit Object Storage** (GCS-backed) | Native, private buckets, no extra vendor. |
| Video tooling | **ffmpeg** (via `replit.nix`) | Frame sampling + thumbnails. |
| AI | **Anthropic API — Claude with vision** (`claude-opus-4-8` for quality, `claude-haiku-4-5` for cheap passes) | Structured output via tool use; strong vision. |
| Deployment | **Replit Reserved VM** (always-on) | Needs a persistent background worker + long jobs; Autoscale sleeps between requests. |
| Job model | **Postgres-backed queue + in-process poller** | Avoids Redis/BullMQ until scale demands it. |
| Secrets | Replit Secrets | `DATABASE_URL`, `ANTHROPIC_API_KEY`, storage creds. |

Deliberately **not** in v1: Redis, BullMQ, Kubernetes, microservices, a separate worker service,
WebSockets. A single Reserved VM running Express + a `setInterval` job poller is enough for one
clip at a time.

---

## Video upload flow

1. Client asks the API for a scoped upload target: `POST /api/uploads/init` with
   `{ filename, contentType, sizeBytes }`.
2. Server validates **server-side** (MP4/MOV mime + extension, size ≤ cap, duration cap enforced
   later at extraction) and returns a **short-lived signed upload URL** + a `clipId`.
3. Client uploads the file **directly to Object Storage** via the signed URL (keeps large blobs off
   the Node process).
4. Client calls `POST /api/clips/:clipId/commit` to confirm the upload landed; server verifies the
   object exists and its size/type, creates the `analysis_job`, and returns `{ jobId, status }`.
5. Client transitions to the existing **Processing** screen and polls job status.

The current drag-drop UI and validation stay; they just now hit `/uploads/init` instead of
faking it. Client-side validation remains as fast feedback; server-side validation is the source
of truth.

---

## File storage strategy

- **Buckets/prefixes (all private):**
  - `clips/{clipId}/source.mp4` — original upload.
  - `clips/{clipId}/frames/{n}.jpg` — sampled frames.
  - `clips/{clipId}/poster.jpg` — one hero frame for `filmRoom.videoPoster` / moment thumbnails.
- **Access:** never public. Serve via short-lived signed **read** URLs generated on demand for the
  poster/thumbnails the UI needs. The UI already treats these as image `src`s.
- **Retention:** delete `source.mp4` and `frames/` after analysis completes (keep only poster +
  thumbnails + the JSON report). Massively cuts storage cost; the source video isn't needed once
  the report exists. Add a nightly sweep for orphaned/expired uploads.

---

## Job queue / processing status model

Single `analysis_jobs` table acting as the queue. One in-process poller (`setInterval`, e.g. every
2–3s) claims the oldest `queued` job with a transactional `UPDATE ... WHERE status='queued'
... RETURNING` (row-lock so only one worker picks it up), runs the pipeline, and advances status.

Status state machine:

```
queued → extracting → analyzing → complete
   └────────────────────────────→ failed   (from any active state)
```

- The **Processing** screen polls `GET /api/clips/:clipId` and maps status → its existing UI:
  `extracting`/`analyzing` = the progress view; `complete` = navigate to Scorecard;
  `failed` = the existing `processingFailed` StatePanel.
- Progress %: v1 shows **phase-based** progress (extracting ≈ 0–40%, analyzing ≈ 40–100%) rather
  than true frame counts — good enough and honest. Keep the animated bar; drive its ceiling from
  the phase.
- Concurrency: **1 active job per session** (and a small global cap) to bound cost and CPU.

---

## Frame extraction plan

- Run `ffmpeg` on the Reserved VM after download-to-tmp (or stream from storage).
- **Sample sparsely:** ~1 frame/sec (tune 0.5–2 fps), scaled down (e.g. 1280px wide, JPEG q~4).
- **Cap total frames** (e.g. ≤ 90) and **cap clip duration** (e.g. ≤ 3 min) — reject/trim longer.
  This bounds both storage and, more importantly, AI token cost.
- Pick one representative frame as `poster.jpg`.
- Extraction failures (corrupt/unreadable file, 0 frames) → job `failed` with a reason code.

---

## AI analysis pipeline

This is the core of v1. The goal is producing the **Analysis Contract** JSON, NHL-specific.

1. **Assemble input:** the sampled frames (batched — either a sequence of images or a few montage
   grids to cut token count), plus metadata (frame timestamps, clip duration).
2. **Model call:** Claude vision with **tool use / structured output** whose schema is the exact
   contract (`scorecard`, `coachingMoments[]`, `filmRoom{}`). Structured output guarantees shape;
   no fragile free-text parsing.
3. **Prompt:** a fixed NHL-gameplay coaching system prompt — grade positioning, defense, passing,
   puck management, decision-making, offensive IQ; identify a few (3–5) timestamped coaching
   moments classified `great | missed | breakdown`; produce commentary, strengths/mistakes, a
   highest-impact adjustment, next-game focus, weekly focus. Timestamps must map to sampled frame
   times so thumbnails line up.
4. **Post-process:** validate against the schema (zod); clamp metric ranges; attach signed
   thumbnail URLs (map each moment's timestamp → nearest extracted frame). Persist as `analyses`.
5. **Cost tiering (optional later):** a cheap Haiku pass to pick the most eventful frames, then an
   Opus pass on that subset. v1 can skip this and just cap frames.

Malformed/failed model output (after 1 retry) → job `failed` (`dataUnavailable` on read).

---

## Database schema (minimal)

```
sessions            -- anonymous device/session for v1 (no auth yet)
  id (uuid, pk)
  created_at

clips
  id (uuid, pk)
  session_id (fk → sessions)
  storage_key (text)         -- clips/{id}/source.mp4
  filename, content_type, size_bytes
  duration_seconds (nullable until probed)
  status (enum: uploading|queued|extracting|analyzing|complete|failed)
  created_at, updated_at

analysis_jobs
  id (uuid, pk)
  clip_id (fk → clips, unique)   -- 1 job per clip in v1
  status (enum matches state machine)
  phase_progress (int 0–100)
  attempts (int)
  error_code (nullable), error_message (nullable)
  claimed_at, started_at, finished_at
  created_at, updated_at

analyses
  id (uuid, pk)
  clip_id (fk → clips, unique)
  report (jsonb)             -- the Analysis Contract (scorecard + moments + filmRoom)
  model, tokens_in, tokens_out, cost_cents   -- for cost tracking
  created_at
```

`report` as `JSONB` keeps the contract intact and lets the UI consume it directly. Promote fields
to columns only when we need to query/aggregate them (e.g. rating history later).

---

## API endpoints (v1)

```
POST /api/uploads/init        → validate; return { clipId, uploadUrl }
POST /api/clips/:id/commit    → verify object; enqueue job; return { jobId, status }
GET  /api/clips/:id           → { status, phaseProgress } (polled by Processing screen)
GET  /api/clips/:id/analysis  → { report } (Scorecard / Film Preview / Film Room read this)
GET  /api/health              → liveness for the deployment
```

Later (post-analysis): `POST /api/auth/*`, `POST /api/billing/checkout`, `GET /api/clips` (history).
Keep routing flat and REST-ish; no GraphQL.

Frontend integration: `AnalysisContext` becomes the API client (holds `clipId` + polled status);
Scorecard/FilmPreview/FilmRoom read `report` instead of the static import. Data shapes are
unchanged, so components stay put.

---

## Security considerations

- **Server-side file validation** (mime, extension, size) — never trust the client.
- **Signed, short-TTL URLs** for both upload and read; private buckets; no public listing.
- **Content limits:** max size, max duration, one file per upload.
- **Input isolation:** run ffmpeg on untrusted files with resource limits/timeouts; treat frames as
  data, not executables.
- **Prompt-injection posture:** the model only receives frames + our fixed prompt and returns
  structured data; we validate output against the schema before storing.
- **No PII in v1** (anonymous sessions). When auth lands, scope every clip/analysis to a user id
  and enforce ownership on every read.
- **Secrets** only in Replit Secrets; never in the client bundle.
- **CORS** locked to the app origin.

---

## Cost controls

- Duration cap (≤ ~3 min) + frame cap (≤ ~90) → bounded tokens per analysis.
- Downscale frames; batch as montages to reduce image tokens.
- **Delete source video + frames after completion** (storage).
- Per-session **daily quota** (e.g. N free analyses/day) enforced in the DB.
- Concurrency cap (1 active job/session, small global cap) to bound compute + API spend.
- Record `tokens_in/out` + `cost_cents` per analysis; add a global daily spend kill-switch that
  parks new jobs as `queued` and shows a friendly "high demand" state if exceeded.
- Prefer the cheapest model that clears quality; reserve Opus for the final structured pass.

---

## Rate limits

- Per-session/IP: uploads per minute + per day (e.g. 3/min, 5/day for anon).
- Global: max concurrent extraction/analysis jobs.
- Standard IP throttle on all write endpoints (express-rate-limit).
- 429 responses map to a clear "you've hit today's free limit" state (reuses StatePanel).

---

## Failure states (map to existing UI)

| Failure | Detection | UI |
|---|---|---|
| Unsupported / oversized file | `/uploads/init` validation | existing Upload error banner |
| Upload didn't land | `/commit` object check fails | Upload error / retry |
| Corrupt / unreadable video | ffmpeg yields 0 frames | job `failed` → `processingFailed` |
| Extraction timeout | worker timeout | job `failed` → `processingFailed` (Try Again re-enqueues) |
| AI call error / timeout | API error after 1 retry | job `failed` → `processingFailed` |
| Malformed AI output | schema validation fails | job `failed` → `dataUnavailable` |
| Over quota / rate limited | quota check | 429 → "daily limit" state |
| Report missing on read | `GET /analysis` 404 | existing `dataUnavailable` StatePanel |

"Try Again" re-enqueues the existing clip (no re-upload) when the source is still retained; after
retention cleanup, it routes back to Upload.

---

## What stays mocked / deferred in v1

- **Auth** — anonymous session id only (cookie/localStorage). Real accounts come later.
- **Payments / Premium** — `PremiumContext` stays a mock flag; the paywall still just flips it. No
  Stripe yet.
- **Video playback & on-ice annotations** — Film Room keeps the poster image + timeline markers;
  no streaming player or drawn overlays yet.
- **"42 coaching moments" scale** — v1 returns a handful (3–5) real moments; the "42" copy becomes
  a computed count or is softened.
- **Progress precision** — phase-based %, not true frame-accurate.
- **History / multiple clips per user, trends, weekly plans over time** — single latest clip only.
- **Notifications, email, sharing** — none.

---

## Exact build order

**Phase 0 — Contract & scaffolding**
1. Freeze the Analysis Contract as a shared `zod` schema + TS types (derive from current
   `mockData.ts`). Frontend and backend import the same types.
2. Stand up Express + TS on a Replit Reserved VM; `/api/health`.
3. Provision Postgres; Drizzle schema + first migration (`sessions`, `clips`, `analysis_jobs`,
   `analyses`).
4. Provision Object Storage bucket + signed-URL helpers.

**Phase 1 — Real upload + storage**
5. `POST /api/uploads/init` (server validation, signed upload URL, create `clip`).
6. `POST /api/clips/:id/commit` (verify object, create `analysis_job` as `queued`).
7. Wire the existing Upload screen to these endpoints (keep client-side validation).

**Phase 2 — Job model + status (still mock analysis)**
8. In-process poller that claims jobs and, for now, writes a **static** contract report after a
   short delay (proves the whole loop end-to-end without AI).
9. `GET /api/clips/:id` status; point the Processing screen's polling at it.
10. `GET /api/clips/:id/analysis`; point Scorecard/FilmPreview/FilmRoom at it.
    → **Milestone: a real uploaded clip flows through storage + DB + job + renders in Film Room.**

**Phase 3 — Frame extraction**
11. Add `ffmpeg` (replit.nix); extraction step (sample, downscale, poster) with caps + timeouts.
12. Store frames/poster; generate signed thumbnail URLs; failure handling → `failed`.

**Phase 4 — Real AI analysis**
13. Anthropic client; NHL coaching prompt; structured-output tool matching the contract.
14. Replace the static report from Phase 2 with the model's validated output; map moment
    timestamps → thumbnails.
    → **Milestone: the primary goal — one uploaded clip analyzed for real, rendered in the
    existing Film Room.**

**Phase 5 — Hardening**
15. Rate limits + per-session daily quota + concurrency cap + global spend kill-switch.
16. Full failure-state coverage + retries; retention cleanup (delete source/frames post-complete);
    orphan sweep.
17. Cost logging per analysis; basic admin/metrics read.

**Phase 6 — Accounts & monetization (only after Phase 4 is solid)**
18. Real auth (accounts, scope clips to users, ownership checks).
19. Stripe: real trial/subscription behind the existing paywall; premium gating server-enforced.
20. Clip history, rating trends, weekly plans over time.

---

### One-line summary
Nail the **Analysis Contract** first, prove the full loop with a **static** report (Phases 0–2),
then slot in **ffmpeg extraction** (Phase 3) and **Claude vision structured analysis** (Phase 4).
Auth and payments wait until a real clip renders in the Film Room.
