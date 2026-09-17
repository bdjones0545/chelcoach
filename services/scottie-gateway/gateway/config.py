"""Scottie gateway configuration. Fail-closed on missing secrets in production mode."""
from __future__ import annotations

import os
import sys
from pathlib import Path
from typing import Any


PROFILE_DEFAULT = Path.home() / ".hermes" / "profiles" / "scottie"
MAX_FRAMES = 12
MAX_IMAGE_BYTES = int(1.5 * 1024 * 1024)  # 1.5 MB
MAX_TOTAL_IMAGE_BYTES = 12 * 1024 * 1024  # 12 MB
MAX_BODY_BYTES = 16 * 1024 * 1024  # request envelope + images
MAX_DIMENSION = 4096
MIN_DIMENSION = 32
TIMESTAMP_TOLERANCE_S = 300
REPLAY_CACHE_MAX = 10_000
IDEMPOTENCY_MAX = 8_000
RATE_WINDOW_S = 60
RATE_MAX = 60
DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 2340
JOB_RETENTION_HOURS = 48


def _load_dotenv(path: Path) -> None:
    if not path.is_file():
        return
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        s = line.strip()
        if not s or s.startswith("#") or "=" not in s:
            continue
        k, v = s.split("=", 1)
        k = k.strip()
        if k and k not in os.environ:
            os.environ[k] = v.strip().strip('"').strip("'")


def _read_secret_file(path: Path) -> str:
    if path.is_file():
        return path.read_text(encoding="utf-8").strip()
    return ""


def load_config(*, allow_missing_secrets: bool = False) -> dict[str, Any]:
    profile = Path(os.environ.get("HERMES_SCOTTIE_HOME", PROFILE_DEFAULT))
    _load_dotenv(profile / ".env")
    sec = profile / "secrets"

    api_key = (os.environ.get("SCOTTIE_API_KEY") or "").strip() or _read_secret_file(
        sec / "scottie_api_key"
    )
    signing = (os.environ.get("SCOTTIE_SIGNING_SECRET") or "").strip() or _read_secret_file(
        sec / "scottie_signing_secret"
    )

    test_mode = os.environ.get("SCOTTIE_TEST_MODE", "").strip() in ("1", "true", "yes")
    if (not api_key or not signing or len(api_key) < 24 or len(signing) < 24) and not (
        allow_missing_secrets or test_mode
    ):
        print(
            "FATAL: Scottie gateway refuses unauthenticated start. "
            "Set SCOTTIE_API_KEY and SCOTTIE_SIGNING_SECRET (min 24 chars).",
            file=sys.stderr,
        )
        sys.exit(2)

    if test_mode and (not api_key or not signing):
        api_key = api_key or ("test-scottie-api-key-" + "x" * 16)
        signing = signing or ("test-scottie-signing-secret-" + "y" * 16)

    provider_name = (os.environ.get("SCOTTIE_PROVIDER") or "fake").strip().lower()
    host = (os.environ.get("SCOTTIE_API_HOST") or DEFAULT_HOST).strip()
    port = int(os.environ.get("SCOTTIE_API_PORT") or DEFAULT_PORT)

    state_dir = Path(os.environ.get("SCOTTIE_STATE_DIR") or (profile / "state"))
    tmp_dir = Path(os.environ.get("SCOTTIE_TMP_DIR") or (state_dir / "tmp"))
    jobs_dir = Path(os.environ.get("SCOTTIE_JOBS_DIR") or (state_dir / "jobs"))

    return {
        "profile": profile,
        "api_key": api_key,
        "signing_secret": signing.encode("utf-8"),
        "host": host,
        "port": port,
        "tolerance": int(os.environ.get("SCOTTIE_TIMESTAMP_TOLERANCE_SECONDS") or TIMESTAMP_TOLERANCE_S),
        "provider": provider_name,
        "provider_model": (os.environ.get("SCOTTIE_PROVIDER_MODEL") or "").strip() or None,
        "provider_timeout_s": float(os.environ.get("SCOTTIE_PROVIDER_TIMEOUT_SECONDS") or "90"),
        "provider_retries": int(os.environ.get("SCOTTIE_PROVIDER_RETRIES") or "1"),
        "state_dir": state_dir,
        "tmp_dir": tmp_dir,
        "jobs_dir": jobs_dir,
        "vault_dir": Path(
            os.environ.get("SCOTTIE_VAULT_DIR")
            or "/root/Desktop/Kevin/Agents/Scottie"
        ),
        "require_bearer": os.environ.get("SCOTTIE_REQUIRE_BEARER", "1") != "0",
        "max_frames": int(os.environ.get("SCOTTIE_MAX_FRAMES") or MAX_FRAMES),
        "max_image_bytes": int(os.environ.get("SCOTTIE_MAX_IMAGE_BYTES") or MAX_IMAGE_BYTES),
        "max_total_image_bytes": int(
            os.environ.get("SCOTTIE_MAX_TOTAL_IMAGE_BYTES") or MAX_TOTAL_IMAGE_BYTES
        ),
        "max_body_bytes": int(os.environ.get("SCOTTIE_MAX_BODY_BYTES") or MAX_BODY_BYTES),
        "service": "scottie",
        "version": "1.0.0",
        "contract_version": "chelcoach-analysis-v1",
        "rubric_version": "chelcoach-rubric-v1",
        "prompt_version": "scottie-prompt-v1",
        # chelcoach.com is not ours (parked); the published route is on chelcoach.io.
        "hostname_public": (os.environ.get("SCOTTIE_PUBLIC_HOSTNAME") or "scottie.chelcoach.io").strip(),
        "test_mode": test_mode,
    }
