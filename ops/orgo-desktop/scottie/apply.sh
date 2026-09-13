#!/usr/bin/env bash
# Configure the Scottie gateway on orgo-desktop for ChelCoach production.
#
# Run from the Mac:
#   bash ops/orgo-desktop/scottie/apply.sh <keys-file>
#
# <keys-file> holds the machine credentials ChelCoach uses to call the gateway (two lines):
#   SCOTTY_API_KEY=<bearer, ≥24 chars>
#   SCOTTY_SIGNING_SECRET=<HMAC secret, ≥24 chars>
# The same values are set on Vercel by scripts/configure-vercel-env.sh (SCOTTY_* variables).
# Never commit the keys file (.gitignore excludes ops/**/*keys*).
#
# What it changes on the VM (each step idempotent, backups alongside as *.bak-chelcoach-<ts>):
#   1. secrets/scottie_api_key and secrets/scottie_signing_secret (0600)
#   2. profile .env: SCOTTIE_PROVIDER=xai (xAI vision through the OpenAI-compatible adapter,
#      key = the profile's existing XAI_API_KEY), base URL, model, public hostname
#   3. restart scottie-gateway and verify /ready reports the new provider
# The gateway keeps binding 127.0.0.1:2340; the public hostname is a Cloudflare published route
# on an existing tunnel connector running on this host.
set -euo pipefail

KEYS_FILE="${1:?usage: apply.sh <keys-file>}"
HOST="${SCOTTIE_HOST:-root@orgo-desktop}"
MODEL="${SCOTTIE_MODEL:-grok-4}"
PUBLIC_HOSTNAME="${SCOTTIE_PUBLIC_HOSTNAME:-scottie.chelcoach.io}"

[ -f "$KEYS_FILE" ] || { echo "keys file not found: $KEYS_FILE" >&2; exit 1; }
API_KEY="$(grep -E '^SCOTTY_API_KEY=' "$KEYS_FILE" | cut -d= -f2- | tr -d '\r\n')"
SIGNING="$(grep -E '^SCOTTY_SIGNING_SECRET=' "$KEYS_FILE" | cut -d= -f2- | tr -d '\r\n')"
[ "${#API_KEY}" -ge 24 ] || { echo "SCOTTY_API_KEY must be ≥24 chars" >&2; exit 1; }
[ "${#SIGNING}" -ge 24 ] || { echo "SCOTTY_SIGNING_SECRET must be ≥24 chars" >&2; exit 1; }

ssh -o BatchMode=yes "$HOST" \
  SCOTTIE_API_KEY_IN="$API_KEY" SCOTTIE_SIGNING_IN="$SIGNING" SCOTTIE_MODEL_IN="$MODEL" SCOTTIE_HOSTNAME_IN="$PUBLIC_HOSTNAME" \
  bash -s <<'REMOTE'
set -euo pipefail
P=/root/.hermes/profiles/scottie
TS="$(date -u +%Y%m%dT%H%M%SZ)"
umask 077

echo "[1/3] secrets"
mkdir -p "$P/secrets"
for pair in "scottie_api_key:$SCOTTIE_API_KEY_IN" "scottie_signing_secret:$SCOTTIE_SIGNING_IN"; do
  name="${pair%%:*}"; value="${pair#*:}"
  f="$P/secrets/$name"
  [ -f "$f" ] && cp -p "$f" "$f.bak-chelcoach-$TS"
  printf '%s' "$value" > "$f"
  chmod 600 "$f"
  echo "  wrote $f ($(wc -c < "$f") bytes)"
done

echo "[2/3] provider config in $P/.env"
ENV="$P/.env"
cp -p "$ENV" "$ENV.bak-chelcoach-$TS"
set_kv() { # key value — replace or append, never print the value
  local key="$1" value="$2"
  if grep -qE "^${key}=" "$ENV"; then
    sed -i "s|^${key}=.*|${key}=${value}|" "$ENV"
  else
    printf '%s=%s\n' "$key" "$value" >> "$ENV"
  fi
  echo "  set $key"
}
grep -qE '^XAI_API_KEY=.{10,}' "$ENV" || { echo "  XAI_API_KEY missing in $ENV — the xai provider needs it" >&2; exit 2; }
set_kv SCOTTIE_PROVIDER xai
set_kv SCOTTIE_PROVIDER_BASE_URL https://api.x.ai/v1
set_kv SCOTTIE_PROVIDER_MODEL "$SCOTTIE_MODEL_IN"
set_kv SCOTTIE_PROVIDER_TIMEOUT_SECONDS 120
set_kv SCOTTIE_PUBLIC_HOSTNAME "$SCOTTIE_HOSTNAME_IN"
set_kv SCOTTIE_REQUIRE_BEARER 1

echo "[3/3] restart + verify"
supervisorctl restart scottie-gateway >/dev/null
for i in $(seq 1 20); do
  if READY="$(curl -sf -m 3 http://127.0.0.1:2340/ready 2>/dev/null)"; then break; fi
  sleep 1
done
echo "  ready: ${READY:-<no response>}"
case "${READY:-}" in *'"provider":"openai_compatible"'*) echo "  provider switched to xai (openai_compatible adapter)";; *) echo "  provider did NOT switch — check /var/log/scottie/gateway.err.log" >&2; exit 3;; esac
REMOTE
echo "done"
