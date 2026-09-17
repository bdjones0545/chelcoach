"""HMAC authentication, replay protection, constant-time compares."""
from __future__ import annotations

import hashlib
import hmac
import threading
import time
from collections import OrderedDict
from dataclasses import dataclass
from typing import Optional


@dataclass
class AuthResult:
    ok: bool
    reason: str = ""
    timestamp: Optional[int] = None


class ReplayCache:
    """Bounded set of seen (ts, signature) pairs for replay protection."""

    def __init__(self, max_size: int = 10_000) -> None:
        self._max = max_size
        self._seen: OrderedDict[str, float] = OrderedDict()
        self._lock = threading.Lock()

    def check_and_add(self, key: str, now: float | None = None) -> bool:
        """Return True if NEW (ok to proceed). False if replay."""
        now = time.time() if now is None else now
        with self._lock:
            if key in self._seen:
                return False
            self._seen[key] = now
            while len(self._seen) > self._max:
                self._seen.popitem(last=False)
            # Drop aged entries older than 20 minutes
            cutoff = now - 1200
            while self._seen:
                k, t = next(iter(self._seen.items()))
                if t >= cutoff:
                    break
                self._seen.popitem(last=False)
            return True


def parse_signature_header(header: str | None) -> tuple[int | None, str | None]:
    if not header or not header.strip():
        return None, None
    h = header.strip()
    if all(c in "0123456789abcdefABCDEF" for c in h) and len(h) in (64, 128):
        return None, h.lower()
    ts_s = None
    sig = None
    for part in h.split(","):
        part = part.strip()
        if part.startswith("t="):
            ts_s = part[2:].strip()
        elif part.startswith("sha256="):
            sig = part[7:].strip().lower()
        elif part.startswith("v1="):
            sig = part[3:].strip().lower()
    if sig is None and "=" not in h and all(c in "0123456789abcdefABCDEF" for c in h):
        sig = h.lower()
    if ts_s is None:
        return None, sig
    if sig is None:
        return None, None
    try:
        return int(ts_s), sig
    except ValueError:
        return None, None


def _normalize_ts_seconds(ts: int) -> float:
    return ts / 1000.0 if ts > 10_000_000_000 else float(ts)


def sign_request(
    secret: bytes | str,
    raw_body: bytes,
    timestamp: int | None = None,
    *,
    method: str = "POST",
    path: str = "/",
) -> tuple[int, str]:
    """Return (ts_ms, hex_digest) for X-ChelCoach-Timestamp + Signature.

    Canonical string: ``{ts_ms}.{METHOD}.{path}.{raw_body}``
    """
    if isinstance(secret, str):
        secret = secret.encode("utf-8")
    if timestamp is None:
        ts = int(time.time() * 1000)
    else:
        ts = int(timestamp)
        # If caller passed seconds, upgrade to ms for uniqueness
        if ts < 10_000_000_000:
            ts = ts * 1000
    method_u = (method or "POST").upper().strip()
    path_s = path or "/"
    if not path_s.startswith("/"):
        path_s = "/" + path_s
    msg = f"{ts}.{method_u}.{path_s}.".encode() + raw_body
    digest = hmac.new(secret, msg, hashlib.sha256).hexdigest()
    return ts, digest


def build_signature_header(
    secret: bytes | str,
    raw_body: bytes,
    timestamp: int | None = None,
    *,
    method: str = "POST",
    path: str = "/",
) -> str:
    ts, dig = sign_request(secret, raw_body, timestamp=timestamp, method=method, path=path)
    return f"t={ts},sha256={dig}"


def verify_request(
    *,
    secret: bytes | str,
    signature_header: str | None,
    timestamp_header: str | None,
    raw_body: bytes,
    tolerance_seconds: int = 300,
    now: float | None = None,
    replay_cache: ReplayCache | None = None,
    bearer_expected: str | None = None,
    authorization_header: str | None = None,
    require_bearer: bool = True,
    method: str = "POST",
    path: str = "/",
) -> AuthResult:
    if isinstance(secret, str):
        secret_b = secret.encode("utf-8")
    else:
        secret_b = secret
    if not secret_b or len(secret_b) < 16:
        return AuthResult(False, "signing_secret_not_configured")

    if require_bearer and bearer_expected:
        auth = (authorization_header or "").strip()
        if not auth.lower().startswith("bearer "):
            return AuthResult(False, "missing_bearer")
        token = auth[7:].strip()
        if not hmac.compare_digest(token, bearer_expected):
            return AuthResult(False, "invalid_bearer")

    ts, provided = parse_signature_header(signature_header)
    if provided is None:
        return AuthResult(False, "missing_or_malformed_signature")
    if ts is None:
        th = (timestamp_header or "").strip()
        if not th:
            return AuthResult(False, "missing_timestamp")
        try:
            ts = int(th)
        except ValueError:
            return AuthResult(False, "malformed_timestamp")

    now_f = time.time() if now is None else now
    ts_sec = _normalize_ts_seconds(ts)
    if abs(now_f - ts_sec) > tolerance_seconds:
        return AuthResult(False, "timestamp_out_of_tolerance", timestamp=ts)

    method_u = (method or "POST").upper().strip()
    path_s = path or "/"
    if not path_s.startswith("/"):
        path_s = "/" + path_s

    # Primary canonical form (ms or s as provided): {ts}.{METHOD}.{path}.{body}
    candidates = [
        f"{ts}.{method_u}.{path_s}.".encode() + raw_body,
    ]
    # Backward-compatible body-only forms used during early integration
    candidates.append(f"{ts}.".encode() + raw_body)
    if ts > 10_000_000_000:
        ts_s = int(ts / 1000)
        candidates.append(f"{ts_s}.{method_u}.{path_s}.".encode() + raw_body)
        candidates.append(f"{ts_s}.".encode() + raw_body)

    matched = False
    for msg in candidates:
        expected = hmac.new(secret_b, msg, hashlib.sha256).hexdigest()
        if hmac.compare_digest(expected, provided.lower()):
            matched = True
            break
    if not matched:
        return AuthResult(False, "signature_mismatch", timestamp=ts)

    if replay_cache is not None:
        # Include method/path so GET polls don't collide with each other as easily
        replay_key = f"{ts}:{method_u}:{path_s}:{provided.lower()}"
        if not replay_cache.check_and_add(replay_key, now=now_f):
            return AuthResult(False, "replay_detected", timestamp=ts)

    return AuthResult(True, "ok", timestamp=ts)
