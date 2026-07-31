#!/usr/bin/env bash
# Local product verification — simulator + Postgres, no production credentials.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

export DATABASE_URL="${DATABASE_URL:-postgresql://chelcoach:chelcoach@127.0.0.1:5432/chelcoach_test}"
export CHELCOACH_RECONCILE_SECRET="${CHELCOACH_RECONCILE_SECRET:-e2e-reconcile-secret}"
export CHELCOACH_E2E_SECRET="${CHELCOACH_E2E_SECRET:-e2e-secret}"

echo "==> shared contracts"
npm --prefix shared ci --prefer-offline
npm --prefix shared test

echo "==> frontend unit + lint + build"
npm ci --prefer-offline
npm run test:frontend
npm run lint
npm run build

echo "==> server unit (memory)"
npm --prefix server ci --prefer-offline
(
  cd server
  CHELCOACH_FORCE_MEMORY_REPOS=1 DATABASE_URL= npm test
)

echo "==> drizzle schema push + postgres job tests"
(
  cd server
  npx drizzle-kit push
  CHELCOACH_RUN_PG_TESTS=1 DATABASE_URL="$DATABASE_URL" npm run test:pg
)

echo "==> server smoke (memory)"
(
  cd server
  CHELCOACH_FORCE_MEMORY_REPOS=1 DATABASE_URL= npm run smoke
)

echo "==> Playwright browsers (chromium)"
npx playwright install chromium

echo "==> critical E2E journeys (chromium)"
npm run test:e2e

echo "==> verify:product complete"
