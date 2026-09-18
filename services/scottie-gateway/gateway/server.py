#!/usr/bin/env python3
"""Scottie Gameplay Analysis Gateway.

Bind: 127.0.0.1:2340 (localhost only)
Auth: Bearer SCOTTIE_API_KEY + HMAC-SHA256 (X-ChelCoach-*)
Never log secrets, images, or prompts.
"""
from __future__ import annotations

import json
import logging
import os
import signal
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

# Allow `python server.py` from services/gateway
_GATEWAY_DIR = Path(__file__).resolve().parent
_SERVICES_DIR = _GATEWAY_DIR.parent
if str(_SERVICES_DIR) not in sys.path:
    sys.path.insert(0, str(_SERVICES_DIR))

from gateway.analysis import AnalysisService  # noqa: E402
from gateway.auth import ReplayCache, verify_request  # noqa: E402
from gateway.config import load_config  # noqa: E402
from gateway.contracts import (  # noqa: E402
    ContractError,
    job_response_public,
    validate_analysis_request,
)
from gateway.jobs import JobStore, JobWorker  # noqa: E402
from gateway.chat import ChatError, validate_chat_request  # noqa: E402
from gateway.provider import build_provider  # noqa: E402

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
    handlers=[logging.StreamHandler(sys.stdout)],
)
log = logging.getLogger("scottie.gateway")

# Redact accidental secret-like keys in logs
_SENSITIVE = ("secret", "token", "authorization", "password", "signature", "api_key", "bearer", "base64")


class RateLimiter:
    def __init__(self, window_s: int = 60, max_n: int = 60) -> None:
        self.window_s = window_s
        self.max_n = max_n
        self._hits: dict[str, list[float]] = {}
        self._lock = threading.Lock()

    def allow(self, key: str) -> bool:
        now = time.time()
        with self._lock:
            arr = self._hits.setdefault(key, [])
            cutoff = now - self.window_s
            self._hits[key] = [t for t in arr if t >= cutoff]
            if len(self._hits[key]) >= self.max_n:
                return False
            self._hits[key].append(now)
            return True


class AppState:
    def __init__(self, cfg: dict[str, Any]) -> None:
        self.cfg = cfg
        self.started_at = time.time()
        self.replay = ReplayCache()
        self.rate = RateLimiter()
        cfg["state_dir"].mkdir(parents=True, exist_ok=True)
        cfg["tmp_dir"].mkdir(parents=True, exist_ok=True)
        cfg["jobs_dir"].mkdir(parents=True, exist_ok=True)
        self.store = JobStore(cfg["jobs_dir"])
        self.provider = build_provider(cfg)
        self.analysis = AnalysisService(
            self.store,
            self.provider,
            vault_dir=cfg.get("vault_dir"),
            tmp_dir=cfg.get("tmp_dir"),
        )
        self.worker = JobWorker(self.store, self.analysis.process)
        self.ready = True
        self.shutting_down = False
        self.requests_handled = 0
        self._lock = threading.Lock()

    def bump(self) -> None:
        with self._lock:
            self.requests_handled += 1


STATE: AppState | None = None


def _json_bytes(obj: Any, status: int = 200) -> tuple[int, bytes, str]:
    return status, json.dumps(obj, separators=(",", ":")).encode("utf-8"), "application/json"


class ScottieHandler(BaseHTTPRequestHandler):
    server_version = "ScottieGateway/1.0"
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt: str, *args: Any) -> None:
        msg = fmt % args
        low = msg.lower()
        if any(s in low for s in _SENSITIVE):
            msg = "[redacted-log-line]"
        log.info("http %s %s", self.address_string(), msg)

    def _send(self, status: int, body: bytes, content_type: str = "application/json") -> None:
        assert STATE is not None
        STATE.bump()
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Scottie-Version", STATE.cfg["version"])
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _send_json(self, status: int, obj: Any) -> None:
        st, body, ct = _json_bytes(obj, status)
        self._send(st, body, ct)

    def _read_body(self, max_bytes: int) -> bytes:
        length = int(self.headers.get("Content-Length") or 0)
        if length < 0:
            raise ContractError("malformed_payload", "Bad Content-Length")
        if length > max_bytes:
            raise ContractError("oversized_request", "Payload too large")
        if length == 0:
            return b""
        data = self.rfile.read(length)
        if len(data) != length:
            raise ContractError("malformed_payload", "Incomplete body")
        return data

    def _auth(self, raw: bytes) -> tuple[bool, str]:
        assert STATE is not None
        cfg = STATE.cfg
        path = urlparse(self.path).path or "/"
        result = verify_request(
            secret=cfg["signing_secret"],
            signature_header=self.headers.get("X-ChelCoach-Signature")
            or self.headers.get("x-chelcoach-signature"),
            timestamp_header=self.headers.get("X-ChelCoach-Timestamp")
            or self.headers.get("x-chelcoach-timestamp"),
            raw_body=raw,
            tolerance_seconds=cfg["tolerance"],
            replay_cache=STATE.replay,
            bearer_expected=cfg["api_key"] if cfg.get("require_bearer") else None,
            authorization_header=self.headers.get("Authorization"),
            require_bearer=bool(cfg.get("require_bearer")),
            method=self.command,
            path=path,
        )
        return result.ok, result.reason

    def do_GET(self) -> None:  # noqa: N802
        assert STATE is not None
        path = urlparse(self.path).path.rstrip("/") or "/"
        if path in ("/health", "/healthz"):
            self._send_json(
                200,
                {
                    "status": "ok",
                    "service": "scottie",
                    "version": STATE.cfg["version"],
                    "uptimeSeconds": int(time.time() - STATE.started_at),
                },
            )
            return
        if path in ("/ready", "/readyz"):
            if STATE.shutting_down or not STATE.ready:
                self._send_json(503, {"ready": False, "service": "scottie"})
                return
            self._send_json(
                200,
                {
                    "ready": True,
                    "service": "scottie",
                    "provider": getattr(STATE.provider, "name", "unknown"),
                    "requestsHandled": STATE.requests_handled,
                },
            )
            return

        # Authenticated GETs need empty-body signature? Allow timestamp+sig over empty body.
        raw = b""
        # For GET with query we still sign empty body
        ok, reason = self._auth(raw)
        if not ok:
            # Allow optional unsigned health only — already handled
            self._send_json(401, {"error": "unauthorized", "reason": reason})
            return

        if path.startswith("/v1/jobs/"):
            job_id = path[len("/v1/jobs/") :].split("/")[0]
            if path.endswith("/report"):
                job = STATE.store.get(job_id)
                if not job:
                    self._send_json(404, {"error": "not_found"})
                    return
                if job.get("status") != "completed" or not job.get("report"):
                    self._send_json(
                        409,
                        {
                            "error": "not_ready",
                            "status": job.get("status"),
                            "jobId": job_id,
                        },
                    )
                    return
                self._send_json(200, job_response_public(job))
                return
            job = STATE.store.get(job_id)
            if not job:
                self._send_json(404, {"error": "not_found"})
                return
            self._send_json(200, job_response_public(job))
            return

        self._send_json(404, {"error": "not_found"})

    def do_POST(self) -> None:  # noqa: N802
        assert STATE is not None
        if STATE.shutting_down:
            self._send_json(503, {"error": "shutting_down"})
            return
        path = urlparse(self.path).path.rstrip("/") or "/"
        try:
            raw = self._read_body(STATE.cfg["max_body_bytes"])
        except ContractError as e:
            self._send_json(413 if e.code == "oversized_request" else 400, {"error": e.code, "message": e.message})
            return

        ok, reason = self._auth(raw)
        if not ok:
            self._send_json(401, {"error": "unauthorized", "reason": reason})
            return

        client_key = self.headers.get("X-ChelCoach-Job-Id") or self.client_address[0]
        if not STATE.rate.allow(str(client_key)):
            self._send_json(429, {"error": "rate_limited", "message": "Too many requests"})
            return

        if path == "/v1/analyze":
            self._handle_analyze(raw)
            return
        if path == "/v1/chat":
            self._handle_chat(raw)
            return
        if path.startswith("/v1/jobs/") and path.endswith("/confirm-player"):
            job_id = path[len("/v1/jobs/") : -len("/confirm-player")].strip("/")
            self._handle_confirm_player(job_id, raw)
            return
        if path.startswith("/v1/jobs/") and path.endswith("/cancel"):
            job_id = path[len("/v1/jobs/") : -len("/cancel")].strip("/")
            job = STATE.store.request_cancel(job_id)
            if not job:
                self._send_json(404, {"error": "not_found"})
                return
            self._send_json(200, job_response_public(job))
            return

        self._send_json(404, {"error": "not_found"})

    def _handle_chat(self, raw: bytes) -> None:
        """Stateless: the report and the turns arrive in the body; nothing is stored here."""
        assert STATE is not None
        try:
            body = json.loads(raw.decode("utf-8") or "{}")
        except Exception:
            self._send_json(400, {"error": "malformed_payload", "message": "Invalid JSON"})
            return
        try:
            report_context, turns = validate_chat_request(body)
        except ChatError as e:
            self._send_json(413 if e.code == "oversized_request" else 400, {"error": e.code, "message": e.message})
            return
        result = STATE.provider.chat(report_context=report_context, turns=turns)
        log.info(
            "chat provider=%s model=%s ok=%s latency_ms=%s turns=%s",
            result.provider, result.model, result.ok, result.latency_ms, len(turns),
        )
        if not result.ok:
            self._send_json(502, {"error": "provider_failed", "message": result.error or "The coach is unavailable right now."})
            return
        self._send_json(
            200,
            {
                "reply": result.reply,
                "provider": result.provider,
                "model": result.model,
                "usage": {"inputTokens": result.input_tokens, "outputTokens": result.output_tokens},
                "latencyMs": result.latency_ms,
            },
        )

    def _handle_confirm_player(self, job_id: str, raw: bytes) -> None:
        assert STATE is not None
        try:
            body = json.loads(raw.decode("utf-8") or "{}")
        except Exception:
            self._send_json(400, {"error": "malformed_payload", "message": "Invalid JSON"})
            return
        if not isinstance(body, dict):
            self._send_json(400, {"error": "malformed_payload", "message": "Body must be object"})
            return
        # Privacy: strip banned real-world identity fields
        banned = {
            "legalName",
            "realName",
            "name",
            "email",
            "face",
            "age",
            "gender",
            "location",
            "voice",
            "accountId",
            "gamertag",
            "ssn",
            "phone",
        }
        for k in list(body.keys()):
            if k in banned:
                body.pop(k, None)
        confirmation = {
            "confirmed": True,
            "jerseyNumber": body.get("jerseyNumber", body.get("jersey_number")),
            "indicatorColor": body.get("indicatorColor", body.get("indicator_color")),
            "position": body.get("position"),
            "teamSide": body.get("teamSide", body.get("team_side")),
            "trackId": body.get("trackId", body.get("track_id") or body.get("selectedPlayerId")),
            "evidenceTimestamps": body.get("evidenceTimestamps") or body.get("timestamp"),
            "evidenceSummary": body.get("evidenceSummary") or ["user_selected_in_game_player"],
            "confidence": float(body.get("confidence") or 0.96),
        }
        # Record correction
        prior = STATE.store.get(job_id) or {}
        self._append_identity_correction(prior, confirmation)

        job = STATE.store.requeue_after_confirmation(job_id, confirmation)
        if not job:
            self._send_json(404, {"error": "not_found"})
            return
        if job.get("status") != "queued" and job.get("error_code") not in (None, "PLAYER_IDENTITY_UNCONFIRMED"):
            # not resumable
            if job.get("status") not in ("queued", "awaiting_player_confirmation"):
                self._send_json(
                    409,
                    {
                        "error": "not_confirmable",
                        "status": job.get("status"),
                        "message": "Job is not awaiting player confirmation",
                    },
                )
                return
        log.info("player_confirmed job=%s clip=%s", job_id, job.get("clip_id"))
        self._send_json(202, job_response_public(job))

    def _append_identity_correction(self, prior: dict, confirmation: dict) -> None:
        vault = STATE.cfg.get("vault_dir") if STATE else None
        if not vault:
            return
        try:
            from pathlib import Path
            import time as _time

            path = Path(vault) / "learning" / "player-identification-corrections.md"
            path.parent.mkdir(parents=True, exist_ok=True)
            if not path.exists():
                path.write_text(
                    "# Player Identification Corrections\n\n"
                    "In-game controlled skater only. No usernames or personal identity.\n\n",
                    encoding="utf-8",
                )
            pi = prior.get("player_identity") or {}
            ts = _time.strftime("%Y-%m-%dT%H:%M:%SZ", _time.gmtime())
            with path.open("a", encoding="utf-8") as f:
                f.write(f"\n## {ts} — user_confirmed\n\n")
                f.write(f"- clip_id: `{prior.get('clip_id')}`\n")
                f.write(f"- job_id: `{prior.get('job_id')}`\n")
                f.write(f"- game_mode: {pi.get('gameMode')}\n")
                f.write(f"- original_prediction_confidence: {pi.get('confidence')}\n")
                f.write(f"- original_indicator: {pi.get('indicatorColor')}\n")
                f.write(f"- original_jersey: {pi.get('jerseyNumber')}\n")
                f.write(f"- confirmed_indicator: {confirmation.get('indicatorColor')}\n")
                f.write(f"- confirmed_jersey: {confirmation.get('jerseyNumber')}\n")
                f.write(f"- confirmed_position: {confirmation.get('position')}\n")
                f.write(f"- confirmed_track: {confirmation.get('trackId')}\n")
                f.write(f"- prior_confidence: {pi.get('confidence')}\n")
                f.write("- failure_reason: user_correction_after_unconfirmed\n")
                f.write("- proposed_identification_improvement: pending_bryan_review if recurrent\n")
        except OSError:
            log.warning("identity_correction_write_failed")

    def do_DELETE(self) -> None:  # noqa: N802
        # cancel alias
        assert STATE is not None
        path = urlparse(self.path).path.rstrip("/") or "/"
        raw = b""
        ok, reason = self._auth(raw)
        if not ok:
            self._send_json(401, {"error": "unauthorized", "reason": reason})
            return
        if path.startswith("/v1/jobs/"):
            job_id = path[len("/v1/jobs/") :]
            job = STATE.store.request_cancel(job_id)
            if not job:
                self._send_json(404, {"error": "not_found"})
                return
            self._send_json(200, job_response_public(job))
            return
        self._send_json(404, {"error": "not_found"})

    def _handle_analyze(self, raw: bytes) -> None:
        assert STATE is not None
        try:
            body = json.loads(raw.decode("utf-8"))
        except Exception:
            self._send_json(400, {"error": "malformed_payload", "message": "Invalid JSON"})
            return

        header_job = self.headers.get("X-ChelCoach-Job-Id") or self.headers.get("x-chelcoach-job-id")
        header_idem = self.headers.get("X-ChelCoach-Idempotency-Key") or self.headers.get(
            "x-chelcoach-idempotency-key"
        )
        if header_job and not body.get("jobId") and not body.get("job_id"):
            body["jobId"] = header_job.strip()
        if header_idem and not body.get("idempotencyKey") and not body.get("idempotency_key"):
            body["idempotencyKey"] = header_idem.strip()

        try:
            parsed = validate_analysis_request(
                body,
                max_frames=STATE.cfg["max_frames"],
                max_image_bytes=STATE.cfg["max_image_bytes"],
                max_total_image_bytes=STATE.cfg["max_total_image_bytes"],
            )
        except ContractError as e:
            code = 413 if e.code == "oversized_request" else 400
            self._send_json(code, {"error": e.code, "message": e.message})
            return

        # Idempotency short-circuit
        if parsed.get("idempotency_key"):
            existing = STATE.store.get_by_idempotency(parsed["idempotency_key"])
            if existing:
                self._send_json(
                    200,
                    {
                        **job_response_public(existing),
                        "deduplicated": True,
                    },
                )
                return

        jpeg_payloads = [f.pop("jpeg_bytes") for f in parsed["frames"]]
        job = STATE.store.create(
            job_id=parsed["job_id"],
            clip_id=parsed["clip_id"],
            contract_version=parsed["contract_version"],
            rubric_version=parsed["rubric_version"],
            metadata=parsed["metadata"],
            frame_metas=parsed["frames"],
            gameplay_context=parsed["gameplay_context"],
            idempotency_key=parsed.get("idempotency_key"),
            jpeg_payloads=jpeg_payloads,
        )
        log.info(
            "job_accepted job=%s clip=%s frames=%s",
            job["job_id"],
            job["clip_id"],
            len(parsed["frames"]),
        )
        self._send_json(202, job_response_public(job))

    def do_HEAD(self) -> None:  # noqa: N802
        self.do_GET()


def main() -> None:
    global STATE
    cfg = load_config()
    # Force localhost bind
    if cfg["host"] not in ("127.0.0.1", "localhost", "::1"):
        log.warning("overriding non-localhost bind %s -> 127.0.0.1", cfg["host"])
        cfg["host"] = "127.0.0.1"

    STATE = AppState(cfg)
    STATE.worker.start()

    server = ThreadingHTTPServer((cfg["host"], cfg["port"]), ScottieHandler)
    server.daemon_threads = True
    server.allow_reuse_address = True

    def _shutdown(signum: int, _frame: Any) -> None:
        log.info("shutdown signal=%s", signum)
        STATE.shutting_down = True
        STATE.ready = False
        STATE.worker.stop(timeout=8)
        # cleanup any lingering jpeg in memory
        threading.Thread(target=server.shutdown, daemon=True).start()

    signal.signal(signal.SIGTERM, _shutdown)
    signal.signal(signal.SIGINT, _shutdown)

    log.info(
        "scottie_gateway_listen host=%s port=%s provider=%s contract=%s rubric=%s",
        cfg["host"],
        cfg["port"],
        cfg["provider"],
        cfg["contract_version"],
        cfg["rubric_version"],
    )
    try:
        server.serve_forever(poll_interval=0.5)
    finally:
        STATE.worker.stop(timeout=5)
        server.server_close()
        log.info("scottie_gateway_stopped")


if __name__ == "__main__":
    main()
