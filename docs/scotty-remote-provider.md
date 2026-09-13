# Provider mode `scotty` — analysis on the Scottie gateway (orgo-desktop)

`CHELCOACH_ANALYSIS_PROVIDER=scotty` sends every accepted submission to the Scottie gateway
that runs on orgo-desktop (`services/gateway/server.py`, supervisord `scottie-gateway`,
loopback `127.0.0.1:2340`, published as `https://scottie.chelcoach.io` through the
Cloudflare tunnel on that host). The model call itself happens on the VM under
`SCOTTIE_PROVIDER=xai`; ChelCoach never holds a model key in this mode.

## Wire contract (`chelcoach-analysis-v1`)

| Call | Purpose |
| --- | --- |
| `POST /v1/analyze` | ≤12 JPEG frames (base64, ≤1.5 MB each, ≤12 MB total), clip metadata, controlled-player hint. Returns `202 {jobId, status}`. |
| `GET /v1/jobs/{id}` | Job status (`queued`, `analyzing_gameplay`, `awaiting_player_confirmation`, `completed`, `failed`, `cancelled`). |
| `GET /v1/jobs/{id}/report` | The Scottie report (scorecard, coaching moments, film room, execution, drills, strategy, faceoffs). `409` until ready. |
| `POST /v1/jobs/{id}/confirm-player` | Forwards ChelCoach's already-confirmed identity when the gateway asks. |
| `POST /v1/jobs/{id}/cancel` | Mirrors a ChelCoach cancellation. |

Every request carries `Authorization: Bearer $SCOTTY_API_KEY`, `X-ChelCoach-Timestamp` (ms) and
`X-ChelCoach-Signature: t=<ms>,sha256=<hex hmac(SCOTTY_SIGNING_SECRET, "{ts}.{METHOD}.{path}." + body)>`.
Client: `server/src/provider/scottyRemote/client.ts`.

## How a job moves

1. `submitAnalysis` writes a `scotty_worker_jobs` row (status `queued`, no `remote` column yet).
2. The per-minute cron `/api/internal/analysis/worker` claims runnable rows with a lease.
   A row without `remote` is **dispatched**: ffmpeg samples ≤12 frames from the signed
   Storage URL, the frames are POSTed, and the gateway job id + frame timestamps are stored
   in `remote` (migration `0005_scotty_worker_remote.sql`).
3. A row with `remote` is **polled** once per tick. Gateway status is mirrored 1:1 into the
   application job; `completed` fetches the report and maps it
   (`reportMapper.ts`) into the contract `ScottyReport` (`reportVersion: scottie-remote-v1`);
   `failed`/`cancelled` map to the contract error codes; `awaiting_player_confirmation`
   forwards the identity ChelCoach already confirmed, once.
4. Outages are transient: the row keeps its `remote` state and is polled again next tick.
   A `400`/`413` on dispatch is permanent (`INVALID_REQUEST`); frame extraction failures
   retry three times. Jobs older than 30 minutes fail with `ANALYSIS_TIMEOUT`.

Worker: `server/src/provider/scottyRemote/worker.ts`. Tests:
`server/src/provider/scottyRemote/scottyRemote.test.ts` (a stand-in gateway that enforces the
real auth).

## Configuration

Vercel (production + preview): `CHELCOACH_ANALYSIS_PROVIDER=scotty`,
`CHELCOACH_SCOTTIE_ENABLED=true`, `SCOTTY_BASE_URL=https://scottie.chelcoach.io`,
`SCOTTY_API_KEY`, `SCOTTY_SIGNING_SECRET` (both ≥24 chars, minted by the operator).
`scripts/configure-vercel-env.sh` writes them when the two secrets are in its environment.

VM: `ops/orgo-desktop/scottie/apply.sh <keys-file>` installs the same two values under the
gateway's secrets directory, switches the gateway from `fake` to the xAI vision provider,
restarts it and checks `/ready`.
