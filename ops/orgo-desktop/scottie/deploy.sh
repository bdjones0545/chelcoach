#!/usr/bin/env bash
# Deploy services/scottie-gateway/ from this repo to the Scottie gateway on orgo-desktop.
#
# Run from the repo root on the Mac:
#   bash ops/orgo-desktop/scottie/deploy.sh            # deploy + restart + verify
#   bash ops/orgo-desktop/scottie/deploy.sh --check    # only report whether the VM matches the repo
#
# What it does (each step idempotent; the previous tree is kept as services.bak-<ts>):
#   1. runs the gateway's unit tests locally — a red suite never ships
#   2. tars gateway/ controls/ strategies/ faceoffs/ research/ scripts/ over ssh (no rsync on the VM),
#      installs them under $P/services and $P/scripts, and the supervisord conf to /etc/supervisor/conf.d
#   3. verifies MANIFEST.sha256 on the VM against what was just written
#   4. supervisorctl update + restart scottie-gateway, then polls /ready
# It never touches .env, secrets/, state/, or the tunnel. Secrets stay where apply.sh put them.
set -euo pipefail

HOST="${SCOTTIE_HOST:-root@orgo-desktop}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
SRC="$REPO_ROOT/services/scottie-gateway"
MODE="${1:-deploy}"

[ -d "$SRC/gateway" ] || { echo "not a chelcoach checkout: $SRC/gateway missing" >&2; exit 1; }

echo "[0/4] regenerating manifest from the repo tree"
(cd "$SRC" && find . -type f ! -name MANIFEST.sha256 ! -path './tests/*' ! -name '*.pyc' ! -path '*__pycache__*' | sort | xargs shasum -a 256 > MANIFEST.sha256)

if [ "$MODE" = "--check" ]; then
  echo "[check] comparing VM tree against repo manifest"
  ssh -o BatchMode=yes "$HOST" 'cd /root/.hermes/profiles/scottie && for f in $(find services/gateway services/controls services/strategies services/faceoffs services/research -type f ! -path "*__pycache__*" ! -name "*.pyc" | sort) scripts/run_scottie_gateway.sh scripts/run_scottie_tunnel.sh; do sha256sum "$f"; done' \
    | sed 's#services/##' | sort -k2 > /tmp/scottie-vm-manifest.txt
  sed 's#\./##' "$SRC/MANIFEST.sha256" | grep -v ' README.md$' | sort -k2 > /tmp/scottie-repo-manifest.txt
  if diff <(awk '{print $1, $2}' /tmp/scottie-vm-manifest.txt) <(awk '{print $1, $2}' /tmp/scottie-repo-manifest.txt); then
    echo "[check] VM matches repo"
  else
    echo "[check] VM DIFFERS from repo (see diff above)" >&2; exit 3
  fi
  exit 0
fi

echo "[1/4] gateway unit tests"
(cd "$SRC" && python3 -m unittest 2>&1 | tail -1)

echo "[2/4] shipping tree to $HOST"
tar -C "$SRC" -czf - --exclude='__pycache__' --exclude='*.pyc' --exclude='tests' \
  gateway controls strategies faceoffs research scripts MANIFEST.sha256 \
  | ssh -o BatchMode=yes "$HOST" 'bash -s' <<'REMOTE'
set -euo pipefail
P=/root/.hermes/profiles/scottie
TS="$(date -u +%Y%m%dT%H%M%SZ)"
STAGE="$(mktemp -d /tmp/scottie-deploy.XXXXXX)"
tar -xzf - -C "$STAGE"

# keep the previous tree
mkdir -p "$P/services.bak-$TS"
for d in gateway controls strategies faceoffs research; do
  [ -d "$P/services/$d" ] && cp -a "$P/services/$d" "$P/services.bak-$TS/"
done
cp -a "$P/scripts/run_scottie_gateway.sh" "$P/scripts/run_scottie_tunnel.sh" "$P/services.bak-$TS/" 2>/dev/null || true
cp -a /etc/supervisor/conf.d/scottie.conf "$P/services.bak-$TS/scottie.conf" 2>/dev/null || true

# install (files 0600 like the originals; scripts executable)
for d in gateway controls strategies faceoffs research; do
  rm -rf "$P/services/$d"
  cp -a "$STAGE/$d" "$P/services/$d"
  find "$P/services/$d" -type f -exec chmod 600 {} +
done
install -m 700 "$STAGE/scripts/run_scottie_gateway.sh" "$P/scripts/run_scottie_gateway.sh"
install -m 700 "$STAGE/scripts/run_scottie_tunnel.sh"  "$P/scripts/run_scottie_tunnel.sh"
install -m 644 "$STAGE/gateway/scottie.supervisord.conf" /etc/supervisor/conf.d/scottie.conf
cp "$STAGE/MANIFEST.sha256" "$P/services/MANIFEST.sha256"
rm -rf "$STAGE"
echo "  installed; previous tree at $P/services.bak-$TS"

echo "[3/4] verifying manifest on the VM"
cd "$P/services"
# manifest paths are ./gateway/..., ./scripts/...; scripts live one level up
fail=0
while read -r sum path; do
  rel="${path#./}"
  case "$rel" in
    README.md) continue ;;
    scripts/*) f="$P/$rel" ;;
    *) f="$P/services/$rel" ;;
  esac
  actual="$(sha256sum "$f" | cut -d' ' -f1)"
  if [ "$actual" != "$sum" ]; then echo "  MISMATCH $rel" >&2; fail=1; fi
done < MANIFEST.sha256
[ "$fail" = 0 ] || { echo "  manifest verification failed" >&2; exit 4; }
echo "  manifest OK"

echo "[4/4] restart + /ready"
supervisorctl update >/dev/null
supervisorctl restart scottie-gateway >/dev/null
for i in $(seq 1 30); do
  if READY="$(curl -sf -m 3 http://127.0.0.1:2340/ready 2>/dev/null)"; then break; fi
  sleep 1
done
echo "  ready: ${READY:-<no response>}"
case "${READY:-}" in *'"provider":"openai_compatible"'*) echo "  provider still xai (openai_compatible)";; *) echo "  provider is NOT xai after restart — check /var/log/scottie/gateway.err.log" >&2; exit 5;; esac
REMOTE

echo "done. public route: https://scottie.chelcoach.io/health"
