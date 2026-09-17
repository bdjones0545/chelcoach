"""Input/output contracts and frame validation for Scottie."""
from __future__ import annotations

import base64
import re
import struct
from typing import Any

from . import CONTRACT_VERSION, PROMPT_VERSION, RUBRIC_VERSION
from .config import (
    MAX_DIMENSION,
    MAX_FRAMES,
    MAX_IMAGE_BYTES,
    MAX_TOTAL_IMAGE_BYTES,
    MIN_DIMENSION,
)

SUPPORTED_CONTRACTS = frozenset({CONTRACT_VERSION, "chelcoach-analysis-v1"})
SUPPORTED_RUBRICS = frozenset({RUBRIC_VERSION, "chelcoach-rubric-v1"})

JOB_STAGES = (
    "queued",
    "inspecting_input",
    "extracting_frames",
    "identifying_controlled_player",
    "validating_player_identity",
    "awaiting_player_confirmation",
    "analyzing_gameplay",
    "validating_report",
    "finalizing",
    "completed",
    "failed",
)

IDENTITY_ERROR_CODE = "PLAYER_IDENTITY_UNCONFIRMED"

METRIC_KEYS = (
    "offensive_positioning",
    "defensive_positioning",
    "decision_making",
    "puck_movement",
    "spacing",
    "transition_play",
)

METRIC_ICONS = {
    "offensive_positioning": "sports_hockey",
    "defensive_positioning": "shield",
    "decision_making": "psychology",
    "puck_movement": "sync_alt",
    "spacing": "location_on",
    "transition_play": "front_loader",
}

METRIC_LABELS = {
    "offensive_positioning": "Offensive Positioning",
    "defensive_positioning": "Defensive Positioning",
    "decision_making": "Decision Making",
    "puck_movement": "Puck Movement",
    "spacing": "Spacing",
    "transition_play": "Transition Play",
}


class ContractError(ValueError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


_JPEG_SOI = b"\xff\xd8"


def _decode_frame_bytes(raw: str) -> bytes:
    s = raw.strip()
    if s.startswith("data:"):
        # data:image/jpeg;base64,...
        if "," not in s:
            raise ContractError("invalid_frame", "Malformed data URL")
        meta, b64 = s.split(",", 1)
        if "jpeg" not in meta.lower() and "jpg" not in meta.lower():
            raise ContractError("unsupported_media", "JPEG only")
        s = b64
    try:
        return base64.b64decode(s, validate=False)
    except Exception as e:
        raise ContractError("invalid_frame", f"Invalid base64: {e}") from e


def _jpeg_dimensions(data: bytes) -> tuple[int, int]:
    if not data.startswith(_JPEG_SOI):
        raise ContractError("unsupported_media", "Not a JPEG (missing SOI)")
    sof_markers = {
        0xC0,
        0xC1,
        0xC2,
        0xC3,
        0xC5,
        0xC6,
        0xC7,
        0xC9,
        0xCA,
        0xCB,
        0xCD,
        0xCE,
        0xCF,
    }
    i = 2
    n = len(data)
    while i < n - 8:
        # skip padding 0xFF bytes
        if data[i] != 0xFF:
            i += 1
            continue
        while i < n and data[i] == 0xFF:
            i += 1
        if i >= n:
            break
        marker = data[i]
        i += 1
        if marker in (0xD8, 0xD9):  # SOI/EOI
            continue
        if marker == 0x01 or (0xD0 <= marker <= 0xD7):  # TEM / RSTn
            continue
        if i + 2 > n:
            break
        seglen = struct.unpack(">H", data[i : i + 2])[0]
        if seglen < 2 or i + seglen > n:
            # Malformed segment — fall through to linear SOF scan
            break
        if marker in sof_markers and seglen >= 7:
            h, w = struct.unpack(">HH", data[i + 3 : i + 7])
            if w > 0 and h > 0:
                return int(w), int(h)
        i += seglen
    # Fallback: linear search for SOF marker (tolerates minor table glitches in fixtures)
    j = 2
    while j < n - 9:
        if data[j] == 0xFF and data[j + 1] in sof_markers:
            try:
                h, w = struct.unpack(">HH", data[j + 5 : j + 9])
                if w > 0 and h > 0:
                    return int(w), int(h)
            except struct.error:
                pass
        j += 1
    raise ContractError("invalid_frame", "Could not read JPEG dimensions")

def validate_analysis_request(
    body: dict[str, Any],
    *,
    max_frames: int = MAX_FRAMES,
    max_image_bytes: int = MAX_IMAGE_BYTES,
    max_total_image_bytes: int = MAX_TOTAL_IMAGE_BYTES,
) -> dict[str, Any]:
    if not isinstance(body, dict):
        raise ContractError("malformed_payload", "Body must be a JSON object")

    job_id = body.get("jobId") or body.get("job_id")
    clip_id = body.get("clipId") or body.get("clip_id")
    if not job_id or not isinstance(job_id, str) or len(job_id) > 128:
        raise ContractError("malformed_payload", "jobId required (string ≤128)")
    if not clip_id or not isinstance(clip_id, str) or len(clip_id) > 128:
        raise ContractError("malformed_payload", "clipId required (string ≤128)")

    contract_version = body.get("contractVersion") or body.get("contract_version") or CONTRACT_VERSION
    rubric_version = body.get("rubricVersion") or body.get("rubric_version") or RUBRIC_VERSION
    if contract_version not in SUPPORTED_CONTRACTS:
        raise ContractError("unsupported_contract", f"Unsupported contract version: {contract_version}")
    if rubric_version not in SUPPORTED_RUBRICS:
        raise ContractError("unsupported_rubric", f"Unsupported rubric version: {rubric_version}")

    # Reject path-like / URL abuse in metadata
    for banned_key in ("path", "filepath", "filePath", "localPath", "url", "sourceUrl"):
        if banned_key in body and body[banned_key]:
            raise ContractError("untrusted_input", f"Field not allowed: {banned_key}")

    metadata = body.get("metadata") or body.get("verifiedMetadata") or {}
    if metadata is None:
        metadata = {}
    if not isinstance(metadata, dict):
        raise ContractError("malformed_payload", "metadata must be an object")
    for k, v in metadata.items():
        if isinstance(v, str) and (
            v.startswith("/")
            or ".." in v
            or v.startswith("file:")
            or re.match(r"^https?://", v, re.I)
        ):
            raise ContractError("untrusted_input", f"metadata.{k} looks like a path/URL")

    frames_in = body.get("frames")
    if not isinstance(frames_in, list) or not frames_in:
        raise ContractError("malformed_payload", "frames must be a non-empty array")
    if len(frames_in) > max_frames:
        raise ContractError("oversized_request", f"Maximum {max_frames} frames")

    frames: list[dict[str, Any]] = []
    total_bytes = 0
    last_ts: float | None = None
    for idx, fr in enumerate(frames_in):
        if not isinstance(fr, dict):
            raise ContractError("malformed_payload", f"frames[{idx}] must be object")
        ts = fr.get("timestamp")
        if ts is None:
            ts = fr.get("timestampSeconds")
        if ts is None:
            raise ContractError("malformed_payload", f"frames[{idx}].timestamp required")
        try:
            ts_f = float(ts)
        except (TypeError, ValueError) as e:
            raise ContractError("malformed_payload", f"frames[{idx}].timestamp invalid") from e
        if ts_f < 0:
            raise ContractError("malformed_payload", f"frames[{idx}].timestamp must be ≥ 0")
        if last_ts is not None and ts_f < last_ts:
            raise ContractError("malformed_payload", "frames must be ordered by non-decreasing timestamp")
        last_ts = ts_f

        b64 = fr.get("jpegBase64") or fr.get("data") or fr.get("imageBase64")
        if not b64 or not isinstance(b64, str):
            raise ContractError("malformed_payload", f"frames[{idx}] missing jpegBase64")
        data = _decode_frame_bytes(b64)
        if len(data) > max_image_bytes:
            raise ContractError("oversized_request", f"frames[{idx}] exceeds per-image limit")
        total_bytes += len(data)
        if total_bytes > max_total_image_bytes:
            raise ContractError("oversized_request", "Total image data exceeds limit")
        w, h = _jpeg_dimensions(data)
        if w > MAX_DIMENSION or h > MAX_DIMENSION or w < MIN_DIMENSION or h < MIN_DIMENSION:
            raise ContractError(
                "oversized_request",
                f"frames[{idx}] resolution out of bounds ({w}x{h})",
            )
        frames.append(
            {
                "index": idx,
                "timestamp": ts_f,
                "width": w,
                "height": h,
                "size_bytes": len(data),
                "jpeg_bytes": data,  # held only during analysis; stripped from persisted job
            }
        )

    context = body.get("gameplayContext") or body.get("context") or {}
    if context is None:
        context = {}
    if not isinstance(context, dict):
        raise ContractError("malformed_payload", "gameplayContext must be object")

    callback = body.get("callback") or {}
    if callback is None:
        callback = {}
    if not isinstance(callback, dict):
        raise ContractError("malformed_payload", "callback must be object")
    if callback.get("url"):
        url = str(callback["url"])
        if not url.startswith("https://"):
            raise ContractError("untrusted_input", "callback.url must be https")

    return {
        "job_id": job_id.strip(),
        "clip_id": clip_id.strip(),
        "contract_version": contract_version,
        "rubric_version": rubric_version,
        "metadata": metadata,
        "frames": frames,
        "gameplay_context": context,
        "callback": callback,
        "idempotency_key": (body.get("idempotencyKey") or body.get("idempotency_key") or "").strip() or None,
    }


def grade_from_rating(chel_rating: int) -> str:
    if chel_rating >= 900:
        return "A+"
    if chel_rating >= 850:
        return "A"
    if chel_rating >= 800:
        return "A-"
    if chel_rating >= 750:
        return "B+"
    if chel_rating >= 700:
        return "B"
    if chel_rating >= 650:
        return "B-"
    if chel_rating >= 600:
        return "C+"
    if chel_rating >= 550:
        return "C"
    if chel_rating >= 500:
        return "C-"
    if chel_rating >= 400:
        return "D"
    return "F"


def tone_for_metric(value: int) -> str:
    if value >= 75:
        return "good"
    if value >= 55:
        return "warn"
    return "bad"


def format_mmss(seconds: float) -> str:
    s = max(0, int(round(seconds)))
    m, sec = divmod(s, 60)
    return f"{m}:{sec:02d}"


def empty_usage() -> dict[str, Any]:
    return {
        "provider": None,
        "model": None,
        "input_tokens": 0,
        "output_tokens": 0,
        "latency_ms": 0,
        "retries": 0,
    }


def job_response_public(job: dict[str, Any]) -> dict[str, Any]:
    """Strip internal fields before returning to ChelCoach."""
    out: dict[str, Any] = {
        "jobId": job["job_id"],
        "clipId": job["clip_id"],
        "status": job["status"],
        "stage": job.get("stage") or job["status"],
        "reportSource": job.get("report_source") or "scottie",
        "contractVersion": job.get("contract_version") or CONTRACT_VERSION,
        "rubricVersion": job.get("rubric_version") or RUBRIC_VERSION,
        "promptVersion": job.get("prompt_version") or PROMPT_VERSION,
        "phaseProgress": job.get("phase_progress", 0),
        "createdAt": job.get("created_at"),
        "updatedAt": job.get("updated_at"),
    }
    if job.get("completed_at"):
        out["completedAt"] = job["completed_at"]
    if job.get("error_code"):
        out["errorCode"] = job["error_code"]
        out["errorMessage"] = job.get("error_message") or "Analysis failed"
    # Controlled-player identity (never real-world identity)
    if job.get("player_identity"):
        out["controlledPlayer"] = job["player_identity"]
    if job.get("status") == "awaiting_player_confirmation" or job.get("error_code") == "PLAYER_IDENTITY_UNCONFIRMED":
        out["requiresUserConfirmation"] = True
        out["confirmationPrompt"] = {
            "message": "Which player are you controlling?",
            "candidates": (job.get("player_identity") or {}).get("candidates") or [],
            "hintFields": ["indicatorColor", "jerseyNumber", "position", "teamSide", "timestamp"],
        }
    if job.get("status") == "completed" and job.get("report"):
        out["report"] = job["report"]
        out["usage"] = job.get("usage") or empty_usage()
        out["providerMetadata"] = {
            "provider": (job.get("usage") or {}).get("provider"),
            "model": (job.get("usage") or {}).get("model"),
            "latencyMs": (job.get("usage") or {}).get("latency_ms"),
            "retries": (job.get("usage") or {}).get("retries"),
        }
    return out
