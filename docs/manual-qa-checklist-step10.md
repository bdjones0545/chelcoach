# Manual Security QA Checklist — Step 10

Use against a production-shaped configuration (fail-closed defaults).

1. **Production environment review** — confirm `CHELCOACH_PRODUCTION_AUTH_READY=false`, analysis submission disabled, simulator/E2E/legacy/callbacks off, distinct internal secrets set.
2. **Cookie / token inspection** — development sessions use bearer tokens; confirm no durable auth secrets in `localStorage` beyond the opaque owner token in non-production.
3. **Logout / revocation** — `POST /api/session/logout` rejects subsequent requests with 401.
4. **Two-user access** — User B requesting User A upload/identification/frame/analysis/report IDs receives generic not-found (no ownership leak).
5. **Browser DevTools secrets** — Network + Sources show no `SCOTTY_*` secrets, DB URLs, or internal secrets.
6. **Network request inspection** — only ChelCoach `/api/*` (non-internal) from the browser.
7. **Media deletion verification** — after cleanup, source object gone; coaching report still readable.
8. **Internal route probing** — `/api/internal/analysis/reconcile` and `/api/internal/media/cleanup` return 404 without the correct distinct secrets; browser cookies alone do not authorize.
9. **Configuration failure startup** — set `CHELCOACH_ANALYSIS_PROVIDER=simulator` with `NODE_ENV=production` and no override → boot fails.
10. **Deployment storage durability** — confirm production media mode is not silently ephemeral local disk, or analysis remains disabled.
