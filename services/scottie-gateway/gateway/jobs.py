"""Job store + lifecycle for Scottie analysis jobs."""
from __future__ import annotations

import json
import threading
import time
import uuid
from pathlib import Path
from typing import Any, Callable

from . import CONTRACT_VERSION, PROMPT_VERSION, RUBRIC_VERSION


def _now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


class JobStore:
    def __init__(self, jobs_dir: Path) -> None:
        self.jobs_dir = jobs_dir
        self.jobs_dir.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        self._jobs: dict[str, dict[str, Any]] = {}
        self._by_idempotency: dict[str, str] = {}
        self._load()

    def _path(self, job_id: str) -> Path:
        safe = "".join(c if c.isalnum() or c in "-_" else "_" for c in job_id)[:128]
        return self.jobs_dir / f"{safe}.json"

    def _load(self) -> None:
        for p in self.jobs_dir.glob("*.json"):
            try:
                data = json.loads(p.read_text(encoding="utf-8"))
                jid = data.get("job_id")
                if not jid:
                    continue
                # never reload jpeg bytes
                data.pop("_frames_blob", None)
                self._jobs[jid] = data
                idem = data.get("idempotency_key")
                if idem:
                    self._by_idempotency[idem] = jid
            except Exception:
                continue

    def _persist(self, job: dict[str, Any]) -> None:
        path = self._path(job["job_id"])
        slim = {k: v for k, v in job.items() if k not in ("_frames_blob", "_jpeg_payloads")}
        tmp = path.with_suffix(".tmp")
        tmp.write_text(json.dumps(slim, indent=2, sort_keys=True), encoding="utf-8")
        tmp.replace(path)

    def get(self, job_id: str) -> dict[str, Any] | None:
        with self._lock:
            j = self._jobs.get(job_id)
            return dict(j) if j else None

    def get_by_idempotency(self, key: str) -> dict[str, Any] | None:
        with self._lock:
            jid = self._by_idempotency.get(key)
            if not jid:
                return None
            j = self._jobs.get(jid)
            return dict(j) if j else None

    def create(
        self,
        *,
        job_id: str | None,
        clip_id: str,
        contract_version: str,
        rubric_version: str,
        metadata: dict[str, Any],
        frame_metas: list[dict[str, Any]],
        gameplay_context: dict[str, Any],
        idempotency_key: str | None,
        jpeg_payloads: list[bytes],
    ) -> dict[str, Any]:
        with self._lock:
            if idempotency_key and idempotency_key in self._by_idempotency:
                existing = self._jobs[self._by_idempotency[idempotency_key]]
                return dict(existing)
            jid = job_id or str(uuid.uuid4())
            if jid in self._jobs:
                # duplicate job id — return existing (idempotent)
                return dict(self._jobs[jid])
            now = _now_iso()
            job = {
                "job_id": jid,
                "clip_id": clip_id,
                "status": "queued",
                "stage": "queued",
                "phase_progress": 0,
                "contract_version": contract_version or CONTRACT_VERSION,
                "rubric_version": rubric_version or RUBRIC_VERSION,
                "prompt_version": PROMPT_VERSION,
                "report_source": "scottie",
                "metadata": metadata,
                "frame_metas": [
                    {k: v for k, v in f.items() if k != "jpeg_bytes"} for f in frame_metas
                ],
                "gameplay_context": gameplay_context,
                "idempotency_key": idempotency_key,
                "created_at": now,
                "updated_at": now,
                "completed_at": None,
                "error_code": None,
                "error_message": None,
                "report": None,
                "usage": None,
                "retry_count": 0,
                "cancel_requested": False,
                "_jpeg_payloads": jpeg_payloads,
            }
            self._jobs[jid] = job
            if idempotency_key:
                self._by_idempotency[idempotency_key] = jid
            self._persist(job)
            return dict(job)

    def update(self, job_id: str, **fields: Any) -> dict[str, Any] | None:
        with self._lock:
            job = self._jobs.get(job_id)
            if not job:
                return None
            job.update(fields)
            job["updated_at"] = _now_iso()
            self._persist(job)
            return dict(job)

    def set_stage(self, job_id: str, stage: str, progress: int) -> None:
        status = "completed" if stage == "completed" else "failed" if stage == "failed" else stage
        # map intermediate stages to status names used externally
        active = (
            "inspecting_input",
            "extracting_frames",
            "identifying_controlled_player",
            "validating_player_identity",
            "awaiting_player_confirmation",
            "analyzing_gameplay",
            "validating_report",
            "finalizing",
        )
        if stage in active:
            status = stage
        fields: dict[str, Any] = {"stage": stage, "status": status, "phase_progress": progress}
        if stage == "completed":
            fields["completed_at"] = _now_iso()
            fields["status"] = "completed"
        if stage == "failed":
            fields["completed_at"] = _now_iso()
            fields["status"] = "failed"
        self.update(job_id, **fields)

    def request_cancel(self, job_id: str) -> dict[str, Any] | None:
        with self._lock:
            job = self._jobs.get(job_id)
            if not job:
                return None
            if job["status"] in ("completed", "failed"):
                return dict(job)
            job["cancel_requested"] = True
            job["status"] = "failed"
            job["stage"] = "failed"
            job["error_code"] = "cancelled"
            job["error_message"] = "Job cancelled"
            job["completed_at"] = _now_iso()
            job["updated_at"] = _now_iso()
            job.pop("_jpeg_payloads", None)
            self._persist(job)
            return dict(job)

    def peek_jpeg(self, job_id: str) -> list[bytes] | None:
        with self._lock:
            job = self._jobs.get(job_id)
            if not job:
                return None
            payloads = job.get("_jpeg_payloads")
            return list(payloads) if payloads is not None else None

    def take_jpeg(self, job_id: str) -> list[bytes] | None:
        with self._lock:
            job = self._jobs.get(job_id)
            if not job:
                return None
            payloads = job.pop("_jpeg_payloads", None)
            return payloads

    def requeue_after_confirmation(self, job_id: str, confirmation: dict[str, Any]) -> dict[str, Any] | None:
        """Resume analysis after ChelCoach user confirms controlled player."""
        with self._lock:
            job = self._jobs.get(job_id)
            if not job:
                return None
            ok_states = {
                "awaiting_player_confirmation",
                "failed",
            }
            if job.get("status") not in ok_states and job.get("error_code") != "PLAYER_IDENTITY_UNCONFIRMED":
                return dict(job)
            if job.get("status") == "failed" and job.get("error_code") not in (
                "PLAYER_IDENTITY_UNCONFIRMED",
                None,
            ):
                # other failures not resumable via confirm
                if job.get("error_code") != "PLAYER_IDENTITY_UNCONFIRMED":
                    return dict(job)
            job["user_confirmation"] = confirmation
            job["status"] = "queued"
            job["stage"] = "queued"
            job["phase_progress"] = 0
            job["error_code"] = None
            job["error_message"] = None
            job["completed_at"] = None
            job["cancel_requested"] = False
            job["updated_at"] = _now_iso()
            self._persist(job)
            return dict(job)

    def cleanup_jpeg(self, job_id: str) -> None:
        with self._lock:
            job = self._jobs.get(job_id)
            if not job:
                return
            job.pop("_jpeg_payloads", None)
            self._persist(job)


class JobWorker:
    """Background single-thread worker processing queued jobs."""

    def __init__(
        self,
        store: JobStore,
        process_fn: Callable[[str], None],
        poll_interval: float = 0.05,
    ) -> None:
        self.store = store
        self.process_fn = process_fn
        self.poll_interval = poll_interval
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._claim_lock = threading.Lock()

    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._loop, name="scottie-worker", daemon=True)
        self._thread.start()

    def stop(self, timeout: float = 5.0) -> None:
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=timeout)

    def _loop(self) -> None:
        while not self._stop.is_set():
            jid = self._claim_next()
            if jid:
                try:
                    self.process_fn(jid)
                except Exception as e:  # noqa: BLE001
                    self.store.update(
                        jid,
                        status="failed",
                        stage="failed",
                        error_code="internal_error",
                        error_message=str(e)[:200],
                        completed_at=_now_iso(),
                    )
                    self.store.cleanup_jpeg(jid)
            else:
                self._stop.wait(self.poll_interval)

    def _claim_next(self) -> str | None:
        with self._claim_lock:
            with self.store._lock:
                for jid, job in self.store._jobs.items():
                    if job.get("status") == "queued" and not job.get("cancel_requested"):
                        job["status"] = "inspecting_input"
                        job["stage"] = "inspecting_input"
                        job["phase_progress"] = 5
                        job["updated_at"] = _now_iso()
                        self.store._persist(job)
                        return jid
        return None
