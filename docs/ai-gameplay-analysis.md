# AI gameplay analysis (Phase 4)

ChelCoach converts extracted gameplay frames into a schema-validated `AnalysisReport`
using a vision-capable model. This document covers configuration, modes, bounds, and
privacy assumptions for developers.

## Provider and model

| Item | Value |
|---|---|
| Provider | Anthropic Messages API (`@anthropic-ai/sdk`) |
| Default model | `claude-sonnet-5` (override with `ANTHROPIC_MODEL`) |
| Capabilities used | Image inputs + structured JSON output (`output_config.format`) |
| Official docs | [Models](https://docs.anthropic.com/en/docs/about-claude/models/overview), [Vision](https://platform.claude.com/docs/en/build-with-claude/vision), [Structured outputs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs) |

**Fallback policy:** change `ANTHROPIC_MODEL` to another current vision-capable Claude
model that supports structured outputs (for example `claude-haiku-4-5` for lower cost).
Do not silently swap in the demo sample report on provider failure.

Node 22 is supported by the official SDK (engines pin `>=22 <23`).

## Environment variables

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `ANTHROPIC_API_KEY` | Live AI only | — | API key (never commit) |
| `ANTHROPIC_MODEL` | No | `claude-sonnet-5` | Model id |
| `AI_PROVIDER` | No | `anthropic` | `anthropic` \| `fake` |
| `AI_REQUEST_TIMEOUT_MS` | No | `90000` | Provider timeout |
| `AI_MAX_ATTEMPTS` | No | `2` | Attempts including first (transient only) |
| `AI_RETRY_BACKOFF_MS` | No | `750` | Base backoff (+ jitter) |
| `AI_MAX_FRAMES` | No | `12` | Frames sent to the model |
| `AI_MAX_IMAGE_BYTES` | No | `1500000` | Per-image raw JPEG cap |
| `AI_MAX_TOTAL_IMAGE_BYTES` | No | `12000000` | Total raw image bytes |
| `AI_MAX_OUTPUT_TOKENS` | No | `8192` | Max generation tokens |

Frame extraction still requires system **ffmpeg/ffprobe** — see `docs/ffmpeg-extraction.md`.

## Demo vs live behavior

| Mode | AI key | Behavior |
|---|---|---|
| Demo / backend flag off | Not required | Frontend mock / `static-demo-clip` sample report (`reportSource: demo`) |
| Live + `AI_PROVIDER=fake` | Not required | Deterministic fake analyzer (tests/smoke) |
| Live + Anthropic configured | Required | Extracted frames → provider → Zod validate → store → `completed` |
| Live + Anthropic not configured | Missing key | `failed` with `ai_not_configured` — **no** sample fallback |
| Live + provider/validation failure | Present | `failed` with mapped AI error code — **no** sample fallback |

## Analysis lifecycle

`queued` → `processing` (`inspecting_video` → `extracting_frames` → `analyzing_gameplay` → `validating_report` → `finalizing`) → `completed` \| `failed`

Extraction success alone does **not** complete the job. Temporary frames are deleted on
success, failure, timeout, and cancellation. Duplicate commits do not restart AI work.

## Request / retry bounds

- Max frames and JPEG sizes are capped (see env table).
- Original video is never sent to the provider.
- Retries only for transient codes (`ai_request_timeout`, `ai_rate_limited`, `ai_provider_unavailable`).
- No retry for auth, schema-invalid output, unsupported content, or configuration errors (beyond the capped attempt policy).
- At most one in-flight analysis per clip id in-process.

## Report provenance (internal)

Stored on the clip record (not on the public `AnalysisReport`):

- `reportSource`: `demo` \| `live_ai` \| `test` \| `deterministic_sample`
- contract / rubric / prompt versions
- provider + model
- optional token usage
- extraction summary (counts/timestamps only)

## Local fake-provider testing

```bash
cd server
AI_PROVIDER=fake npm test
AI_PROVIDER=fake npm run smoke
```

Inject a custom provider in tests via `setAnalysisProviderForTests(...)`.

## Optional real-provider verification

```bash
cd server
# requires ANTHROPIC_API_KEY; never runs in CI
npm run verify:live-ai
```

If the key is absent, the script exits 0 and reports **not run**.

## Privacy considerations

- Frames are sent only to the configured Anthropic endpoint when live AI runs.
- Frame bytes and base64 payloads are not logged; buffers are released after the request.
- Temporary workspace frames are deleted after each job.
- Provider output is untrusted and Zod-validated against `shared/analysisContract.ts`.
- Secrets and raw provider bodies are never returned to clients.
- User-controlled / on-screen text is delimited; system instructions tell the model to ignore injection.
- No arbitrary URL fetches of user content for analysis (base64 frames only).

Anthropic’s current API data-retention terms are defined by Anthropic’s official
API/data-retention documentation. ChelCoach does not claim zero-retention unless the
deployed Anthropic account is configured for that product feature.

## Known limitations

- In-process queue (not multi-instance safe; jobs die on restart).
- No Postgres persistence of reports yet.
- No payments, auth, or distributed workers in this phase.
- Rubric scores are model-assessed coaching guidance, not a scientifically validated rating system.
