#!/usr/bin/env bash
# Cloudflare Tunnel for Scottie — token file required; no-op loop if missing.
set -euo pipefail
export HOME="${HOME:-/root}"
TOKEN_FILE="${SCOTTIE_TUNNEL_TOKEN_FILE:-/root/.hermes/profiles/scottie/secrets/cloudflared-scottie.token}"
METRICS="${SCOTTIE_CLOUDFLARED_METRICS:-127.0.0.1:20245}"
ORIGIN="${SCOTTIE_ORIGIN:-http://127.0.0.1:2340}"

if [[ ! -f "$TOKEN_FILE" ]] || [[ ! -s "$TOKEN_FILE" ]]; then
  echo "[scottie-tunnel] token missing or empty at $TOKEN_FILE — sleeping (no public exposure)"
  while true; do sleep 3600; done
fi

TOKEN="$(tr -d ' \n\r\t' < "$TOKEN_FILE")"
if [[ -z "$TOKEN" ]]; then
  echo "[scottie-tunnel] empty token — sleeping"
  while true; do sleep 3600; done
fi

echo "[scottie-tunnel] starting cloudflared metrics=${METRICS} origin=${ORIGIN}"
exec cloudflared tunnel --no-autoupdate --metrics "$METRICS" run --token "$TOKEN"
