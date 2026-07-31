#!/usr/bin/env bash
# Install root, shared, and server package dependencies from the repo root.
# ChelCoach is three separate npm projects (not workspaces). Root-only
# `npm ci` does not install shared/ or server/ deps and breaks Vercel builds.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

echo "[install-all] root: npm ci"
npm ci

echo "[install-all] shared: npm ci"
npm --prefix shared ci

echo "[install-all] server: npm ci"
npm --prefix server ci

echo "[install-all] complete"
