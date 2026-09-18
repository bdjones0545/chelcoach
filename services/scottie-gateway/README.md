# Scottie analysis gateway

**This directory is the source of truth** for the code that runs ChelCoach's production analysis
on orgo-desktop. It started (PR #39) as a byte-for-byte snapshot of the unversioned tree under
`/root/.hermes/profiles/scottie/`; since then it is edited here, tested in CI, and shipped with
`ops/orgo-desktop/scottie/deploy.sh`. A change made on the VM and not here will show up as a
manifest mismatch (`deploy.sh --check`).

| | |
| --- | --- |
| Runs on | `orgo-desktop`, Hermes profile `scottie`, supervisord `scottie-gateway`, loopback `127.0.0.1:2340`, published as `https://scottie.chelcoach.io` |
| Deploy | `bash ops/orgo-desktop/scottie/deploy.sh` (tests → ship → verify manifest → restart → `/ready`) |
| Verify drift | `bash ops/orgo-desktop/scottie/deploy.sh --check` |
| Tests | `python3 -m unittest -v` here (stdlib only; also a CI step) |
| Not in git | `.env`, `secrets/`, `state/`, the Cloudflare tunnel token — `ops/orgo-desktop/scottie/apply.sh` manages those |

## What is in here

- `gateway/server.py` — HTTP server: `POST /v1/analyze`, `GET /v1/jobs/{id}`, `/report`,
  `confirm-player`, `cancel`, `/health`, `/ready`. Bearer + HMAC verification in `auth.py`
  (the ChelCoach side is `server/src/provider/scottyRemote/client.ts`).
- `gateway/provider.py` — the model call and **the system prompt** (`system_prompt()`), plus the
  deterministic `FakeProvider` used for tests.
- `gateway/rubric.py` — `chelcoach-rubric-v1`: six 0–100 metrics, weights, the 0–1000 Chel Rating
  fold (`chel_rating_from_metrics`), and the honest band labels (`percentile_label`).
- `gateway/validator.py` — normalizes the model's JSON into the wire report. Its bounded repair
  path (`attempt_repair`) may fill gaps with placeholder content; everything it invents is listed
  in `report.repair.synthesized` and survives to the wire.
- `gateway/analysis.py` — the job pipeline. A repair that had to synthesize `coachingMoments`
  fails the job (`invalid_report`) rather than shipping a placeholder as an observation.
- `gateway/player_identity.py`, `attribution.py` — controlled-player identification before
  scoring, and the "grade only the controlled skater" gate.
- `controls/`, `strategies/`, `faceoffs/` — the per-title registries. Only an **NHL 26** fixture
  exists for each, and production has `SCOTTIE_CONTROL_GUIDANCE_ENABLED=false` and
  `SCOTTIE_STRATEGY_GUIDANCE_ENABLED=false`, so neither attaches anything to a production report.
- `research/` — the registry research loop the `research_hook.py` files call into.
- `scripts/` — the supervisord entry points. They read secrets from files; none are embedded.
- `tests/` — unit tests pinning the defects below.

## Wire contract additions since the snapshot

- `POST /v1/chat` — Ask Scottie about one completed report. Body `{reportContext, messages}`
  (≤20 turns, ≤1500 chars each, last from the user; report ≤40 KB). Reply from the same provider
  as analysis (`gateway/chat.py`), text-only, ≤450 tokens, under a system prompt that forbids
  anything not in the report. Stateless: nothing is stored on the gateway.

- `report.repair` — present only when the repair path ran:
  `{"applied": true, "synthesized": ["metrics", "commentary", …], "notes": [...]}`.
  ChelCoach (`server/src/provider/scottyRemote/reportMapper.ts`) withholds the Chel Rating when
  `metrics` is listed, discloses any placeholder prose, and refuses a report listing
  `coachingMoments`.

## Defects found in the 2026-09-17 audit — fixed

1. ~~`gateway/config.py` defaulted the public hostname to `scottie.chelcoach.com`~~ (not our
   domain) → `scottie.chelcoach.io`. Test: `HostnameDefault`.
2. ~~The repair path's fabricated flat rubric was indistinguishable on the wire; its `_repaired`
   marker never survived `validate_report()`~~ → `report.repair` (above); synthesized moments
   fail the job. Test: `RepairProvenance`.
3. ~~`"NHL 26"` hardcoded as the fallback title in `analysis.py`, `controls/registry.py`,
   `faceoffs/engine.py`~~ → `_resolve_game_title()` takes it from the request or returns
   `"unspecified"` with a warning; a test greps the tree for literal NHL years.
4. ~~supervisord set `SCOTTIE_PROVIDER="fake"` and the `.env` won only by sourcing order~~ →
   the conf no longer sets it; `run_scottie_gateway.sh` sources `.env` first, applies `fake` only
   as a last resort, and prints the provider it chose. Test: `ProviderPrecedence`.
