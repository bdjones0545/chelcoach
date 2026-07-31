# Scotty shared contracts & media retention (Step 1)

This phase defines versioned Zod contracts shared by the ChelCoach frontend, ChelCoach
backend, local Scotty simulator, and eventual Scotty gateway. It also establishes
upload-retention policy and a cleanup-service foundation for gameplay videos up to
**30 minutes**.

**Out of scope for Step 1:** Cloudflare tunnel, live Scotty HTTP client, paid vision
calls, final polling UX, and full player-confirmation UI.

## Contract location

```text
shared/scotty/
  version.ts          SCOTTY_CONTRACT_VERSION = "1.0.0"
  enums.ts
  player-context.ts
  game-context.ts
  upload.ts           raw upload metadata + public view (no storage keys)
  lease.ts            processing leases
  analysis-request.ts
  job.ts
  player-identification.ts
  confirmation.ts
  controls.ts
  strategies.ts
  faceoffs.ts
  drills.ts
  report.ts
  errors.ts
  retention.ts        policy schema + UTC eligibility helpers
  profile.ts          reusable gameplay preferences (Step 2)
  games.ts            NHL title catalog + support status (Step 2)
  media-classification.ts
  upload-context.ts   create-session + public upload detail (Step 2)
  index.ts
```

Server re-export: `server/src/scottyContract.ts`.

## Versioning

Every analysis request / job / error / report carries `contractVersion`.
Incompatible **major** versions are rejected as `UNSUPPORTED_CONTRACT_VERSION`.

## Upload storage architecture

| Concern | Where it lives |
|---|---|
| Raw video bytes | Object storage (`server/src/storage.ts`) — memory or Replit |
| Ownership, keys, status, retention | Postgres-ready tables / in-memory retention repo |
| Validated reports | JSONB / in-memory report store — **retained** after media delete |

**Video binaries are not stored in Postgres.** The `media_uploads` table stores only
references and metadata.

## Retention policy

| Env | Default | Meaning |
|---|---|---|
| `CHELCOACH_RAW_MEDIA_RETENTION_HOURS` | `24` | Normal raw/frame/temp deletion deadline |
| `CHELCOACH_RAW_MEDIA_MAX_RETENTION_HOURS` | `48` | Absolute max for stuck jobs |
| `CHELCOACH_MAX_UPLOAD_BYTES` | `2147483648` (2 GB) | Matches current `uploadRules.maxBytes` |

Central loader: `server/src/retention/policy.ts`.
Eligibility helpers: `shared/scotty/retention.ts`.
Cleanup service: `server/src/retention/cleanup.ts` (fake storage in CI).

Suggested scheduler cadence (later): **once per hour**, single batch — not one timer per upload.

## Duration

Maximum trusted duration: **1,800 seconds**. Over → `VIDEO_DURATION_EXCEEDED`.
Trusted ffprobe/inspection duration overrides client-declared duration.

## Public messaging after deletion

```text
Source gameplay video expired and was deleted after the retention period.
Your coaching report remains available.
```

Storage object keys are never exposed on public upload views.

## Step 2 follow-on

Upload sessions, gameplay profiles, streamed media storage, and trusted inspection are
documented in [scotty-upload-step2.md](scotty-upload-step2.md).
