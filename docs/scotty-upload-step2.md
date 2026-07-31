# Scotty Step 2 — Upload sessions & gameplay profile

Step 2 makes ChelCoach capable of safely accepting short clips and full-game uploads
(up to **30 minutes** / configured max bytes) while collecting and persisting the
gameplay context Scotty will eventually need.

**Out of scope:** controlled-player confirmation UI, live Scotty provider, local
simulator, Cloudflare, analysis polling, report redesign.

## Architecture (memory-safe ingress)

```text
Browser → POST /api/uploads (auth + context) → pending record + upload URL
       → PUT  /api/uploads/:id/content (streamed) → disk object store
       → trusted ffprobe inspection → ready
```

- Ingress is **server-streamed** to disk with a byte-limit transform and Node stream
  backpressure. The full video is **not** held as one `Buffer` / `arrayBuffer`.
- Preferred future path: direct-to-object-storage signed uploads. Replit’s current
  `uploadFromBytes` client may still buffer once if syncing disk → Replit after finalize;
  that limitation is logged. HTTP ingress remains streamed.
- Fake storage + fake media inspector are used in CI.

Object key pattern:

```text
chelcoach/uploads/{ownerId}/{uploadId}/source
```

## APIs

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/session` | Mint opaque owner token (pseudonymous) |
| `GET`/`PUT` | `/api/gameplay-profile` | Load / partial-update preferences |
| `POST` | `/api/uploads` | Create pending session + upload instructions |
| `PUT` | `/api/uploads/:id/content` | Streamed body upload |
| `POST` | `/api/uploads/:id/complete` | Verify storage + inspect (also run after PUT) |
| `GET` | `/api/uploads/:id` | Owner-scoped public detail (no storage keys) |
| `DELETE` | `/api/uploads/:id` | Cancel + delete partial object |

## Lifecycle

`pending → uploading → uploaded → processing → ready`

Failures / cancel → `expired` with cleanup of partial objects.
Abandoned pending sessions expire after `CHELCOACH_PENDING_UPLOAD_EXPIRATION_HOURS` (default 2).

## Profile vs upload overrides

- Profile stores reusable defaults.
- Each upload persists an immutable gameplay context snapshot.
- Form changes do **not** update the profile unless **Save these settings as my defaults** is checked.

## Media classification (trusted duration)

| Class | Duration |
|---|---|
| `short_clip` | ≤ 120s |
| `extended_clip` | > 120s and < 900s |
| `full_game` | 900–1800s |

Over 1800s → `VIDEO_DURATION_EXCEEDED`.

## Persistence

- Drizzle tables: `gameplay_profiles`, extended `media_uploads`.
- Runtime: Drizzle when `DATABASE_URL` is set; in-memory otherwise (CI default).
- Raw video is never stored in Postgres.
