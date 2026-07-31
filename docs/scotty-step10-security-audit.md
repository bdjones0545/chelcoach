# ChelCoach Step 10 — Production Security, Durability, and Feature-Flag Audit

## Executive summary

Step 10 hardens ChelCoach for safe connection to an external Scotty worker in Step 11.

**Authentication decision: Option B** — no production authentication system exists. Pseudonymous `development_session` minting remains for local/E2E only and is blocked in production by default. Analysis submission in production stays disabled until durable auth, storage, retention, and explicit enablement are all ready.

**Verdict: `STEP 10 COMPLETE WITH BLOCKERS`**

Primary remaining blockers for live production analysis:

1. Production authentication system not implemented (`CHELCOACH_PRODUCTION_AUTH_READY` cannot honestly be `true`).
2. Durable object storage for production media not configured (`CHELCOACH_PRODUCTION_MEDIA_STORAGE_READY` / `object_storage`).
3. Remote Scotty transport, HMAC signing, and callbacks intentionally not activated (Step 11).

---

## Audit matrix (selected)

| Area | Current implementation | Expected production guarantee | Finding | Severity | Files affected | Fix | Test evidence | Residual risk |
|---|---|---|---|---|---|---|---|---|
| Authentication | In-memory opaque bearer sessions | Explicit mode; no silent prod pseudonymous auth | Option B documented; mint blocked in prod | high | `auth/session.ts`, `routes/session.ts`, `config/*` | Auth mode + readiness | `session.security.test.ts`, config tests | Multi-instance session store still memory |
| Authorization | `requireOwnerAuth` + owner checks | Central matrix; generic cross-user | Central helpers + generic 404 on submit | medium | `security/authorization.ts`, submission | Strip client owner IDs | E2E step10, unit | Some legacy routes still 403 vs 404 wording |
| Identification durability | Was in-memory | Postgres when DATABASE_URL | Drizzle repo wired | critical→fixed | `identification/drizzleRepository.ts`, `persistence.ts` | Wire drizzle | PG identification tests | None for durability path |
| Retention durability | Was in-memory | Durable eligibility + locks | Drizzle retention + cleanup route | critical→fixed | `retention/drizzleRepository.ts`, `routes/internalMedia.ts` | Wire + secret | PG retention tests | Cleanup uses media adapter |
| Provider flags | Partial fail-closed | No silent fallback | Central config + fake blocked in prod | high | `config/chelcoachConfig.ts`, `provider/config.ts` | Startup validation | config tests | — |
| E2E hooks | Mode flag | Impossible in production | Boot assert + router gate | high | `e2e/hooks.ts` | Hard block | security tests | — |
| Internal routes | String compare reconcile | Timing-safe distinct secrets | Reconcile + cleanup secrets | high | `routes/analysis.ts`, `internalMedia.ts` | `requireInternalSecret` | E2E step10 | Rate limit is process-local |
| CSRF | Absent | Protect mutations | Origin allow-list + custom header | medium | `security/csrf.ts`, frontend headers | Dual model | E2E CSRF test | Bearer-only clients without Origin rely on header/auth |
| CORS | Allow-all default | Explicit prod origins | Boot requires CORS_ORIGIN in prod | high | `app.ts`, config | Fail closed | config tests | — |
| Rate limits | Absent | Per-route classes | In-process limiter | medium | `security/rateLimit.ts` | Presets | security unit | Not distributed |
| Security headers / CSP | Absent | Private API + CSP | Middleware + API CSP | medium | `security/headers.ts` | Applied globally | E2E headers | Frontend CSP separate from API |
| Secrets / logging | Mixed | No leak | Redaction helpers | medium | `security/logging.ts` | Redact | unit | Manual log review ongoing |
| Callbacks | Skeleton | Disabled / signed | Still 404 when disabled; secret required if enabled | high | `routes/analysis.ts` | Fail closed | E2E boundary | Processing still disabled |
| Legacy upload | Open | Disabled in prod | Flag-gated mount | medium | `app.ts` | `CHELCOACH_LEGACY_UPLOAD_ENABLED` | config tests | Demo path remains in non-prod |
| Reconciliation multi-instance | FOR UPDATE on sync | No duplicate reports | Candidate select still racey; sync locked | medium | `drizzleJobRepository.ts` | Documented | E2E reconcile dedupe | Stronger SKIP LOCKED claim still recommended |

---

## Findings by severity

### Critical (addressed or blocked)
- In-memory identification/retention in production paths → **fixed** via Drizzle wiring when `DATABASE_URL` is set.
- Pseudonymous auth usable as silent production auth → **blocked** (Option B + readiness).
- E2E / simulator / fake / Anthropic reachable in production → **fail-closed**.

### High
- Production auth not implemented (blocker).
- Production media durability not proven (blocker).
- Process-local rate limits / sessions (acceptable pre-Step 11 with single instance; document for scale-out).

### Medium
- Reconciliation candidate selection without `SKIP LOCKED` claim (sync uses row locks; residual multi-instance race on work selection).
- Distributed cleanup lock is DB-backed per upload; global batch overlap still process-gated.

### Low / informational
- Frontend still stores opaque owner token in `localStorage` for development sessions (rejected server-side in production).
- Dependency audit may report transitive findings — see dependency section.

---

## Authentication decision

**Option B — Production authentication not yet available.**

- `CHELCOACH_AUTH_MODE=development_session` for local/test.
- `CHELCOACH_PRODUCTION_AUTH_READY=false` by default.
- Production session mint returns `503 SESSION_MINT_DISABLED`.
- Analysis readiness requires `existing_auth` + `productionAuthReady` in production.

---

## Authorization model

Resources: gameplay profile, media upload, source media, player identification, confirmation frames, player confirmation, analysis job, provider confirmation, analysis report, cancellation.

Actions: create, read, update, delete, submit, confirm, cancel, stream.

Ownership is always taken from server persistence after `requireOwnerAuth`. Browser-supplied `ownerId` / `userId` fields are stripped on analysis submission.

---

## Feature-flag inventory

| Flag | Default | Dev | Test | Production | Notes |
|---|---|---|---|---|---|
| `CHELCOACH_AUTH_MODE` | `development_session` | session mint | session mint | must not be development with ready=true | Option B |
| `CHELCOACH_PRODUCTION_AUTH_READY` | `false` | n/a | n/a | requires `existing_auth` | Blocker |
| `CHELCOACH_ANALYSIS_PROVIDER` | `fake` (dev) / `scotty` (prod default parse) | flexible | flexible | fail-closed | No silent fallback |
| `CHELCOACH_SCOTTIE_ENABLED` | `false` | off | off | off until Step 11 | |
| `CHELCOACH_SCOTTY_SIMULATOR_ENABLED` | `true` non-prod | on | on | off unless override | |
| `CHELCOACH_SCOTTY_SIMULATOR_ALLOW_IN_PRODUCTION` | `false` | — | — | explicit only | |
| `CHELCOACH_PRODUCTION_AUTH_READY` | `false` | — | — | false | |
| `CHELCOACH_SCOTTY_CALLBACKS_ENABLED` | `false` | off | off | off | Unsigned rejected |
| `CHELCOACH_E2E_MODE` | unset | E2E only | optional | **startup fail** | |
| `CHELCOACH_LEGACY_UPLOAD_ENABLED` | `!production` | on | on | must false | |
| `CHELCOACH_ANALYSIS_SUBMISSION_ENABLED` | unset | not required | not required | must `1` | |
| `CHELCOACH_MEDIA_STORAGE_MODE` | derived | local_disk/memory | memory/disk | object_storage preferred | |
| `CHELCOACH_PRODUCTION_MEDIA_STORAGE_READY` | `false` | — | — | explicit | |
| `CHELCOACH_RECONCILE_SECRET` | unset | E2E set | — | required for route | Distinct |
| `CHELCOACH_CLEANUP_SECRET` | unset | E2E set | — | required for cleanup | Distinct |
| `CHELCOACH_USE_FFMPEG_FRAMES` | existing | optional | optional | optional | Unchanged |

---

## Production defaults (fail closed)

```
analysis submission disabled
Scotty remote disabled
simulator disabled (unless explicit override)
direct Anthropic disabled
fake provider disabled
callbacks disabled
E2E hooks disabled
legacy upload disabled
development auth mint disabled
internal routes secret-gated
cleanup/reconcile require distinct secrets
CORS origins required
```

---

## Durable identification & retention

- `DrizzleIdentificationRepository` persists identification, frames (metadata), candidates, confirmations, processing leases.
- Frame bytes remain in object/disk store; DB holds keys only.
- `DrizzleRetentionRepository` lists deletion candidates from durable expiry fields, uses `media_cleanup_locks`, reads leases, preserves reports.
- Scheduler: `POST /api/internal/media/cleanup` or `npm run cleanup:media`.

---

## Secret boundaries

| Secret | Purpose |
|---|---|
| Session / owner token | Browser bearer (dev) |
| `CHELCOACH_RECONCILE_SECRET` | Internal reconcile |
| `CHELCOACH_CLEANUP_SECRET` | Internal cleanup |
| `CHELCOACH_CALLBACK_SECRET` | Future callbacks |
| `SCOTTY_SIGNING_SECRET` | Future Scotty HMAC |
| `DATABASE_URL` | Server DB |
| Anthropic key | Dev adapter only |

Must not be reused across trust boundaries. Placeholder values rejected.

---

## Rate limits & quotas

Per-route in-process limits for session, upload, stream, identification, analysis, confirmation, cancel, status (high), report, internal.

Quotas: `CHELCOACH_MAX_ACTIVE_JOBS_PER_USER` (5), `CHELCOACH_MAX_DAILY_SUBMISSIONS_PER_USER` (20), `CHELCOACH_MAX_CONCURRENT_UPLOADS_PER_USER` (3).

---

## Dependency audit

Commands:

```bash
npm run audit:deps
# → npm audit --omit=dev (root + server)
```

Record findings from the run in CI/PR notes. Do not claim zero vulnerabilities without the audit output. Transitive issues in unused Replit storage paths may be accepted with rationale.

---

## Remaining blockers (Step 11 inputs)

1. Real production authentication (`existing_auth`) with durable sessions.
2. Production object storage configuration and `CHELCOACH_PRODUCTION_MEDIA_STORAGE_READY=true` (or equivalent).
3. Scotty base URL + signing secret + `CHELCOACH_SCOTTIE_ENABLED` for supervised transport.
4. Optional: Redis/distributed rate limits; session store; `SKIP LOCKED` reconcile claiming.
5. Keep callbacks disabled until signing + freshness fully specified.

---

## Final verdict

**`STEP 10 COMPLETE WITH BLOCKERS`**

Step 10 security/durability/fail-closed posture is implemented and tested. ChelCoach is safe to *begin* Step 11 transport work only after treating production auth and durable media storage as explicit blockers for unattended production analysis.
