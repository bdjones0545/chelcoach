#!/usr/bin/env bash
# Run Scottie analysis gateway on localhost only.
#
# Precedence, explicit: the profile .env wins over the process environment (supervisord no longer
# sets SCOTTIE_PROVIDER); defaults below apply only when neither set a value.
set -euo pipefail
export HERMES_SCOTTIE_HOME="${HERMES_SCOTTIE_HOME:-/root/.hermes/profiles/scottie}"
export HOME="${HOME:-/root}"
export PATH="/root/.local/bin:/usr/local/bin:/usr/bin:/bin:${PATH:-}"

# 1. Profile .env (never printed)
if [[ -f "${HERMES_SCOTTIE_HOME}/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "${HERMES_SCOTTIE_HOME}/.env"
  set +a
fi

# 2. Defaults only where nothing set a value
export SCOTTIE_API_HOST="${SCOTTIE_API_HOST:-127.0.0.1}"
export SCOTTIE_API_PORT="${SCOTTIE_API_PORT:-2340}"
export SCOTTIE_PROVIDER="${SCOTTIE_PROVIDER:-fake}"

# 3. Secrets files
if [[ -z "${SCOTTIE_API_KEY:-}" && -f "${HERMES_SCOTTIE_HOME}/secrets/scottie_api_key" ]]; then
  SCOTTIE_API_KEY="$(tr -d '\n' < "${HERMES_SCOTTIE_HOME}/secrets/scottie_api_key")"
  export SCOTTIE_API_KEY
fi
if [[ -z "${SCOTTIE_SIGNING_SECRET:-}" && -f "${HERMES_SCOTTIE_HOME}/secrets/scottie_signing_secret" ]]; then
  SCOTTIE_SIGNING_SECRET="$(tr -d '\n' < "${HERMES_SCOTTIE_HOME}/secrets/scottie_signing_secret")"
  export SCOTTIE_SIGNING_SECRET
fi

echo "[scottie-gateway] provider=${SCOTTIE_PROVIDER} host=${SCOTTIE_API_HOST} port=${SCOTTIE_API_PORT}"
mkdir -p "${HERMES_SCOTTIE_HOME}/state/jobs" "${HERMES_SCOTTIE_HOME}/state/tmp" /var/log/scottie
cd "${HERMES_SCOTTIE_HOME}"
exec /usr/bin/python3 "${HERMES_SCOTTIE_HOME}/services/gateway/server.py"
