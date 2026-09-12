#!/usr/bin/env bash
# Configure the ChelCoach Vercel environment (production + preview) from the repository's
# inventory in docs/vercel-production-environment.md.
#
# Run from the repo root by the project owner (the Vercel CLI must be logged in and the project
# linked: `npx vercel link --project chelcoach --scope train-efficiency`).
#
# Non-secret values are set verbatim. Internal secrets are generated here, once, and never
# printed. Owner-held secrets are read from the environment when present and skipped otherwise:
#
#   SUPABASE_SERVICE_ROLE_KEY   DATABASE_URL   DATABASE_URL_MIGRATE   ANTHROPIC_API_KEY
#
# When SUPABASE_SERVICE_ROLE_KEY is provided, media storage is switched to supabase_storage and
# marked production-ready in the same run; otherwise it stays on local_disk (uploads disabled).
#
# Usage:
#   SUPABASE_ANON_KEY=... bash scripts/configure-vercel-env.sh          # non-secret + generated
#   SUPABASE_ANON_KEY=... SUPABASE_SERVICE_ROLE_KEY=... DATABASE_URL=... ANTHROPIC_API_KEY=... \
#     bash scripts/configure-vercel-env.sh                              # everything
#   PREVIEW_BRANCH=my-branch bash scripts/configure-vercel-env.sh   # also CORS for one preview branch
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
export VERCEL_TELEMETRY_DISABLED=1

SUPABASE_PROJECT_URL="https://vsigeidtmpewgjvklzwu.supabase.co"
# The anon (publishable) key ships in the browser bundle, so it is not a secret, but it is also
# not committed: read it from the environment (Supabase dashboard → Project Settings → API).
SUPABASE_ANON="${SUPABASE_ANON_KEY:-}"
if [ -z "$SUPABASE_ANON" ]; then
  echo "SUPABASE_ANON_KEY is required (the project's anon/publishable key)." >&2
  exit 1
fi

vercel_cli() { npx -y vercel@latest "$@"; }

set_var() { # name value env [branch]
  local name="$1" value="$2" env="$3" branch="${4:-}"
  if [ -n "$branch" ]; then
    printf '%s' "$value" | vercel_cli env add "$name" "$env" "$branch" --force >/dev/null
    echo "  set $name ($env, branch $branch)"
  else
    printf '%s' "$value" | vercel_cli env add "$name" "$env" --force >/dev/null
    echo "  set $name ($env)"
  fi
}

gen_secret() { node -e 'process.stdout.write(require("crypto").randomBytes(24).toString("base64url"))'; }

CRON_SECRET_VALUE="$(gen_secret)"
RECONCILE_SECRET_VALUE="$(gen_secret)"
CLEANUP_SECRET_VALUE="$(gen_secret)"
INSPECTION_SECRET_VALUE="$(gen_secret)"

STORAGE_MODE="local_disk"
STORAGE_READY="false"
if [ -n "${SUPABASE_SERVICE_ROLE_KEY:-}" ]; then
  STORAGE_MODE="supabase_storage"
  STORAGE_READY="true"
fi

for ENV in production preview; do
  echo "[$ENV]"
  set_var CHELCOACH_AUTH_MODE supabase_auth "$ENV"
  set_var CHELCOACH_PRODUCTION_AUTH_READY true "$ENV"
  set_var SUPABASE_URL "$SUPABASE_PROJECT_URL" "$ENV"
  set_var SUPABASE_ANON_KEY "$SUPABASE_ANON" "$ENV"
  set_var VITE_SUPABASE_URL "$SUPABASE_PROJECT_URL" "$ENV"
  set_var VITE_SUPABASE_ANON_KEY "$SUPABASE_ANON" "$ENV"
  set_var CHELCOACH_LEGACY_UPLOAD_ENABLED false "$ENV"
  set_var CHELCOACH_MEDIA_STORAGE_MODE "$STORAGE_MODE" "$ENV"
  set_var CHELCOACH_PRODUCTION_MEDIA_STORAGE_READY "$STORAGE_READY" "$ENV"
  set_var SUPABASE_GAMEPLAY_BUCKET chelcoach-gameplay "$ENV"
  set_var SUPABASE_DERIVED_MEDIA_BUCKET chelcoach-derived-media "$ENV"
  set_var CHELCOACH_ANALYSIS_PROVIDER "${ANALYSIS_PROVIDER:-scotty_worker}" "$ENV"
  set_var CHELCOACH_ANALYSIS_SUBMISSION_ENABLED "${ANALYSIS_SUBMISSION_ENABLED:-false}" "$ENV"
  set_var CHELCOACH_INSPECTION_WORKER_INLINE 1 "$ENV"
  set_var CHELCOACH_SCOTTIE_ENABLED false "$ENV"
  set_var CHELCOACH_DB_SSL_MODE require "$ENV"
  set_var CRON_SECRET "$CRON_SECRET_VALUE" "$ENV"
  set_var CHELCOACH_RECONCILE_SECRET "$RECONCILE_SECRET_VALUE" "$ENV"
  set_var CHELCOACH_CLEANUP_SECRET "$CLEANUP_SECRET_VALUE" "$ENV"
  set_var CHELCOACH_INSPECTION_WORKER_SECRET "$INSPECTION_SECRET_VALUE" "$ENV"
  [ -n "${SUPABASE_SERVICE_ROLE_KEY:-}" ] && set_var SUPABASE_SERVICE_ROLE_KEY "$SUPABASE_SERVICE_ROLE_KEY" "$ENV"
  [ -n "${DATABASE_URL:-}" ] && set_var DATABASE_URL "$DATABASE_URL" "$ENV"
  [ -n "${DATABASE_URL_MIGRATE:-}" ] && set_var DATABASE_URL_MIGRATE "$DATABASE_URL_MIGRATE" "$ENV"
  [ -n "${ANTHROPIC_API_KEY:-}" ] && set_var ANTHROPIC_API_KEY "$ANTHROPIC_API_KEY" "$ENV"
done

echo "[production CORS]"
set_var CORS_ORIGIN "https://chelcoach.io,https://www.chelcoach.io" production
if [ -n "${PREVIEW_BRANCH:-}" ]; then
  slug="$(printf '%s' "$PREVIEW_BRANCH" | tr '/' '-' | tr '[:upper:]' '[:lower:]')"
  set_var CORS_ORIGIN "https://chelcoach-git-${slug}-train-efficiency.vercel.app" preview "$PREVIEW_BRANCH"
fi

echo
echo "Done. Redeploy main WITHOUT build cache so the VITE_* values are baked into the bundle."
[ -z "${SUPABASE_SERVICE_ROLE_KEY:-}" ] && echo "Note: SUPABASE_SERVICE_ROLE_KEY not provided — media storage left on local_disk (uploads disabled)."
[ -z "${DATABASE_URL:-}" ] && echo "Note: DATABASE_URL not provided — API runs with in-memory repositories."
[ -z "${ANTHROPIC_API_KEY:-}" ] && echo "Note: ANTHROPIC_API_KEY not provided — analysis provider cannot serve traffic."
exit 0
