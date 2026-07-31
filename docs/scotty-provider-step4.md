# Scotty Step 4 — Provider interface & transport boundary

Step 4 introduces the stable application-side provider boundary. ChelCoach does not
depend on a specific model provider; Cloudflare / HMAC / tunnel details stay isolated
inside future transport adapters.

**Out of scope:** live Scotty calls, Cloudflare, full simulator (Step 5), persistent
polling lifecycle (Step 6), report UI redesign.

## Architecture

```text
Application service → ScottyProvider → Fake | DirectAnthropic | HttpScotty (skeleton)
```

Route handlers never import Anthropic clients, tunnel URLs, or signing secrets.

## Modes

| `CHELCOACH_ANALYSIS_PROVIDER` | Behavior |
|---|---|
| `fake` (default) | Deterministic local provider |
| `direct_anthropic` | Dev-only stub; blocked in production |
| `scotty` | Requires `CHELCOACH_SCOTTIE_ENABLED=true` + URL + signing secret; **no network in Step 4** |

Silent fallback from `scotty` → `fake` is forbidden.

## Submission

`POST /api/uploads/:uploadId/analysis`

Preconditions: ready upload, supported game, identification `identified` or `confirmed`,
ownership, retention. Unresolved identity → `PLAYER_IDENTITY_UNCONFIRMED`.

Idempotency key: upload + effective player version + capabilities + contract major.
Fingerprint conflict → `IDEMPOTENCY_CONFLICT`.

## Minimal persistence

In-memory (CI) / future Drizzle: application request ID, upload ID, owner, provider,
idempotency key, external job ID, fingerprint, accepted timestamp, last status.

Full job lifecycle remains Step 6.

## Frontend

After identity is ready: **Analyze my gameplay** → `ready_to_submit | submitting | accepted | submission_failed`.
No fake percentages. No provider configuration in the client.
