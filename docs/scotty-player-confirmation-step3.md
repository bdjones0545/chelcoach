# Scotty Step 3 — Controlled-player confirmation

Step 3 establishes the ChelCoach-side recovery workflow when controlled-player
identification is low-confidence. Live Scotty / Cloudflare are **not** connected;
deterministic fixtures drive the adapter.

## Flow

```text
Upload ready → Identify → identified | confirmation_required
→ User selects candidate → confirmed → ready for future Scotty analysis
```

No coaching report is generated in this phase.

## States (separate from upload / job status)

`not_started → checking → identified | confirmation_required | failed`  
`confirmation_required → confirmed | unresolved | expired`  
`identified → confirmation_required` (user correction)

## APIs

| Method | Path |
|---|---|
| `POST`/`GET` | `/api/uploads/:uploadId/player-identification` |
| `POST` | `/api/uploads/:uploadId/player-confirmation` |
| `POST` | `/api/uploads/:uploadId/player-confirmation/correct` |
| `POST` | `/api/uploads/:uploadId/player-confirmation/none-of-the-above` |
| `GET` | `/api/uploads/:uploadId/player-confirmation/frames/:frameId` |

Frame bytes require owner auth; object keys are never returned.

## Adapter

`FixtureControlledPlayerIdentifier` — replaceable in Step 4 by a Scotty provider
without changing frontend or confirmation persistence contracts.

Provider labels: `fixture` | `local_simulator` (never mislabeled as Scotty).

## Env

```env
CHELCOACH_PLAYER_IDENTITY_CONFIDENCE_THRESHOLD=0.75
CHELCOACH_CONFIRMATION_FRAME_MAX_EDGE=1280
CHELCOACH_CONFIRMATION_FRAME_MAX_BYTES=500000
CHELCOACH_ALLOW_IDENTITY_FIXTURES=1   # dev/CI
CHELCOACH_LEGACY_UPLOAD_MAX_BYTES=52428800  # buffered demo path cap
```

## Legacy upload audit

`PUT /api/clips/:id/file` remains for demo smoke only, capped at 50 MiB by default.
Production Upload UI uses streamed `POST /api/uploads` + `PUT …/content`.
