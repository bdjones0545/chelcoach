# Scottie analysis gateway — source snapshot

This directory is a **byte-for-byte snapshot** of the code that runs ChelCoach's production
analysis on orgo-desktop. Until this PR, that code existed in no repository: it lived only under
`/root/.hermes/profiles/scottie/` on the VM (not a git checkout). The rubric, prompt, attribution
gate, identity validator, and the control/strategy registries that define what a ChelCoach
report *is* were unreviewable.

| | |
| --- | --- |
| Source host | `orgo-desktop`, Hermes profile `scottie` |
| Source paths | `services/{gateway,controls,strategies,faceoffs,research}`, `scripts/run_scottie_*.sh` |
| Snapshot taken | 2026-09-17 |
| Files on the VM last modified | 2026-07-31 (all of them) |
| Integrity | `MANIFEST.sha256` — verified equal to `sha256sum` output on the VM at snapshot time |
| Excluded | `.env`, `secrets/`, `state/`, `__pycache__`, the Cloudflare tunnel token |

**Deployment has not changed.** The VM still runs its own copy under supervisord
(`scottie-gateway`, loopback `127.0.0.1:2340`, published as `https://scottie.chelcoach.io`).
`ops/orgo-desktop/scottie/apply.sh` configures it. Editing files here does nothing until someone
copies them to the VM and restarts the service — see "Making this the source of truth" below.

To re-verify, hash the same file set on the VM (`find … -type f ! -path '*__pycache__*' ! -name
'*.pyc' | sort | xargs sha256sum`, plus the two scripts), strip the `services/` prefix, and diff
against `MANIFEST.sha256` (which uses `./` paths). A one-line difference means the VM drifted.

## What is in here

- `gateway/server.py` — HTTP server: `POST /v1/analyze`, `GET /v1/jobs/{id}`, `/report`,
  `confirm-player`, `cancel`, `/health`, `/ready`. Bearer + HMAC verification in `auth.py`
  (the ChelCoach side is `server/src/provider/scottyRemote/client.ts`).
- `gateway/provider.py` — the model call and **the system prompt** (`system_prompt()`), plus the
  deterministic `FakeProvider` used for CI.
- `gateway/rubric.py` — `chelcoach-rubric-v1`: six 0–100 metrics, weights, the 0–1000 Chel Rating
  fold (`chel_rating_from_metrics`), and the honest band labels (`percentile_label`).
- `gateway/validator.py` — normalizes the model's JSON into the wire report; **its repair path
  fills every metric with 55 when the model returned none** and strips its own `_repaired`
  marker. ChelCoach's mapper detects the flat rubric and withholds the rating.
- `gateway/player_identity.py`, `attribution.py` — controlled-player identification before
  scoring, and the "grade only the controlled skater" gate.
- `controls/`, `strategies/`, `faceoffs/` — the per-title registries. Only an **NHL 26** fixture
  exists for each, and production has `SCOTTIE_CONTROL_GUIDANCE_ENABLED=false` and
  `SCOTTIE_STRATEGY_GUIDANCE_ENABLED=false`, so neither attaches anything to a production report.
- `research/` — the registry research loop the `research_hook.py` files call into.
- `scripts/` — the supervisord entry points. They read secrets from files; none are embedded.

## Known defects visible in the snapshot (not fixed here — this PR is a copy, not a change)

1. `gateway/config.py:111` defaults `SCOTTIE_PUBLIC_HOSTNAME` to `scottie.chelcoach.com`.
   chelcoach.com is not ours (it is parked on Afternic); production overrides this in `.env` to
   `scottie.chelcoach.io`. The default should change.
2. `gateway/validator.py` repair path (above): a fabricated flat rubric is indistinguishable on
   the wire from a scored one. A `repaired: true` flag that survives to the response would let
   ChelCoach stop guessing.
3. `gateway/analysis.py` defaults the game title to `"NHL 26"` in three places when the request
   carries none; ChelCoach always sends one, so this is inert today.
4. `gateway/scottie.supervisord.conf` sets `SCOTTIE_PROVIDER="fake"`; the profile `.env`
   (`SCOTTIE_PROVIDER=xai`) wins because `run_scottie_gateway.sh` sources it after the
   supervisord environment. Fragile ordering, worth making explicit.

## Making this the source of truth

Not done in this PR. The path is: a deploy script under `ops/orgo-desktop/scottie/` that syncs
this directory to `/root/.hermes/profiles/scottie/services/` + `scripts/`, verifies the manifest
on the VM, and restarts `scottie-gateway`; then a CI job that runs the gateway's own tests (there
are none yet) with `SCOTTIE_PROVIDER=fake`. Until then, any change on the VM that is not mirrored
here will show up as a manifest mismatch.
