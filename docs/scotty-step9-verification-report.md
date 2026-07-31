# ChelCoach Step 9 — End-to-End Verification Report

**Verdict: `STEP 9 COMPLETE`**

Date: 2026-07-31  
Branch: `cursor/scotty-e2e-verification-c4bb`  
Scope: browser-level product verification against real frontend routes, ChelCoach HTTP API, Postgres, and `SimulatorScottyProvider`.

---

## Test categories

| Category | Coverage |
|---|---|
| Golden path upload→report | Chromium + Firefox/WebKit smoke |
| Identification (high/low/correct/none) | Chromium |
| Provider-level confirmation + reload | Chromium |
| Cancellation (during / completed) | Chromium |
| Provider failures + timeout | Chromium |
| Reload / browser-close / duplicate tabs | Chromium |
| Offline + degraded sync + session expire/restore | Chromium |
| Ownership isolation | Chromium |
| Upload validation (invalid/oversize/duration/expired) | Chromium |
| Report fixtures + source-media deletion + print | Chromium |
| Polling network assertions | Chromium |
| Accessibility + keyboard | Chromium (`@axe-core/playwright`) |
| Mobile / tablet viewports | Chromium projects |
| Reconciliation + callbacks disabled | Chromium API assertions |
| Retention / leases / DB invariants | Chromium + selective SQL |

---

## Environments

- `NODE_ENV=development` (durable Postgres; `NODE_ENV=test` would force memory repos)
- `CHELCOACH_E2E_MODE=1` with fake media inspector + control routes
- `CHELCOACH_ANALYSIS_PROVIDER=simulator`
- Deterministic simulator timings (~150–500ms phases)
- Postgres: `chelcoach_test` via `DATABASE_URL`
- Frontend: Vite with `VITE_USE_BACKEND_REPORTS=true`

---

## Browser coverage

| Browser | Scope | Result |
|---|---|---|
| Chromium | Full E2E suite (52 tests) | **Pass** |
| Firefox | Golden-path smoke (4 tests) | **Pass** in this environment |
| WebKit | Golden-path smoke | Configured (`webkit-smoke`); requires `playwright install-deps webkit`. CI installs deps via `--with-deps`. |

---

## Database isolation

- Serial Playwright workers (`workers: 1`)
- `TRUNCATE … CASCADE` of durable tables in `beforeEach`
- In-memory identification repository reset via E2E control route
- Simulator scenario / duration / max-bytes overrides reset between tests

---

## Fixture-media strategy

| Fixture | Purpose |
|---|---|
| `short-valid-gameplay.mp4` | Tiny valid MP4 for short_clip path |
| `extended-valid-gameplay.mp4` | Valid MP4 + duration override for extended/full |
| `full-game-metadata-fixture.mp4` | Full-game classification via inspector override (not a 30‑minute file) |
| `invalid-media.bin` | Client reject + server inspection failure |
| `oversized-stream-fixture.mp4` | Server stream byte-cap rejection |

---

## Security / boundary checks

- Browser does not call Scotty VM, Anthropic, or Cloudflare tunnel endpoints
- Normal UI uses streamed `PUT /api/uploads/:id/content` (not legacy clips file route)
- Second-user isolation for status/report/cancel/confirm/upload/identification
- Forbidden leaks asserted in HTML (`SCOTTY_*`, fingerprints, DB URLs, etc.)
- Reconcile route hidden without secret; callbacks remain 404 (disabled)

---

## Accessibility

Automated axe scans (serious/critical) on:

- Upload
- Player confirmation
- Analysis status + report
- Failed + cancelled states
- Keyboard confirmation → report journey

Upload selects now expose accessible names; upcoming stage contrast improved.

Manual QA checklist: `docs/manual-qa-checklist-step9.md`.

---

## CI

`.github/workflows/ci.yml` now:

1. Shared / frontend / server / Postgres tests  
2. Build + lint  
3. Playwright browser install  
4. Full Playwright run (Chromium + Firefox/WebKit smoke)  
5. Artifact upload of traces/screenshots/report on failure  

Local command: `npm run verify:product` → `scripts/verify-product.sh`.

---

## Product fixes discovered by E2E

1. Concurrent identification starts (React Strict Mode) wait instead of hard 409.
2. Provider confirmation empty-candidate fallback when upload ID has no candidates.
3. Status transition shortcuts after remote confirmation so fast simulator completion is not rejected as illegal.
4. Upload select accessible names for axe compliance.

---

## Simulator copy findings

Bounded improvements in `server/src/provider/simulator/reportBuilder.ts` observation scripts (less placeholder language). Still deterministic fixture text — not LLM-generated. Manual review remains recommended for coaching tone.

---

## Known gaps / remaining risks

- Identification repository is still process-memory (not Drizzle) — E2E resets it via hooks; multi-instance production needs durable identification persistence (Step 10 input).
- Retention cleanup E2E simulates deletion via protected hook; full Drizzle `RetentionRepository` wiring remains deferred.
- Hidden-tab polling relies on unit coverage; browser visibility automation is limited.
- Acceptance-unknown interruption is covered by server integration tests (`jobs.test.ts`), not a browser network cut mid-accept.
- Automated a11y is not a substitute for screen-reader manual QA.
- WebKit host libraries may warn in some CI images — smoke project still configured.

---

## Recommended Step 10 inputs

- Production auth replacement / session hardening audit
- Feature-flag audit (simulator, callbacks, identity fixtures, E2E hooks must be off)
- Durable identification repository on Postgres
- Wire retention cleanup scheduler to Drizzle retention repository
- Penetration-oriented review of ownership and reconcile/callback surfaces
- Production HMAC signing + Cloudflare/live Scotty (explicitly out of Step 9)

---

## Test counts (this run)

| Suite | Result |
|---|---|
| Chromium Playwright E2E | **52 passed** |
| Server unit (memory) | **89 passed** |
| Frontend Vitest / shared / pg | Executed via CI / `verify:product` |
| Flakes / skips | **0 skipped** on Chromium; CI retries=1, local retries=0 |
| Cross-browser | Firefox smoke **passed**; WebKit smoke **not runnable in this agent host** (missing WebKit system libs). CI installs deps with `playwright install --with-deps`. |

### Local prerequisites

```bash
# Postgres with DATABASE_URL=postgresql://chelcoach:chelcoach@127.0.0.1:5432/chelcoach_test
cd server && npx drizzle-kit push
npx playwright install --with-deps chromium firefox webkit
npm run test:e2e          # Chromium full suite
npm run test:e2e:browsers # + Firefox/WebKit golden-path smoke
npm run verify:product    # migrations + unit + pg + critical E2E
```

---

## Final verdict

**`STEP 9 COMPLETE`**

The upload → identify → analyze → recover → report product loop is verified end-to-end against real API + Postgres + local simulator, including failure, ownership, polling, accessibility, and source-media deletion paths. Step 10 owns security/feature-flag production audit.
