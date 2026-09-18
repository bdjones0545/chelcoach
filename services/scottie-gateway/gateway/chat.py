"""Chat with Scottie about one completed report.

Stateless on the gateway: ChelCoach sends the report (already validated on its side) and the
recent turns; nothing is stored here. The same discipline as analysis applies — Scottie may only
talk about what the sampled frames and the report say, and must say so when asked for more.
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any

MAX_REPORT_CONTEXT_BYTES = 40_000
MAX_TURNS = 20
MAX_TURN_CHARS = 1_500
MAX_REPLY_TOKENS = 450

CHAT_SYSTEM_PROMPT = """You are Scottie, the film-room analyst for ChelCoach, talking with the player whose EA SPORTS NHL clip you analyzed.

You have ONE source of truth: the coaching report below, which was built from a small number of frames sampled from their clip. Everything you say must trace to it.

Rules:
- Only discuss this clip and this report. If the player asks about something the report does not cover — a play between sampled frames, a stat that was not counted, another game, a teammate — say plainly that the sampled frames do not show it. Never guess.
- Never invent statistics, shot counts, faceoff results, or events. Numbers come from the report or not at all.
- The Chel Rating and metric scores, if present, are estimates from sampled frames. Say "estimate" when you cite them.
- Refer to moments by their timestamp so the player can find them in their own clip.
- Do not recommend button inputs unless the report's control guidance lists them.
- Coach like a person: direct, specific, encouraging, no fluff. Two to five short paragraphs at most; plain text, no markdown headers.
- Never ask for or repeat real-world identity (name, gamertag, email, location).
"""


class ChatError(ValueError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


@dataclass
class ChatResult:
    ok: bool
    reply: str = ""
    error: str = ""
    provider: str = ""
    model: str = ""
    input_tokens: int = 0
    output_tokens: int = 0
    latency_ms: int = 0


def validate_chat_request(body: Any) -> tuple[dict[str, Any], list[dict[str, str]]]:
    """Bound everything the caller sends. Returns (report_context, turns)."""
    if not isinstance(body, dict):
        raise ChatError("malformed_payload", "Body must be an object")
    report = body.get("reportContext")
    if not isinstance(report, dict) or not report:
        raise ChatError("malformed_payload", "reportContext must be a non-empty object")
    if len(json.dumps(report)) > MAX_REPORT_CONTEXT_BYTES:
        raise ChatError("oversized_request", "reportContext too large")
    raw_turns = body.get("messages")
    if not isinstance(raw_turns, list) or not raw_turns:
        raise ChatError("malformed_payload", "messages must be a non-empty list")
    if len(raw_turns) > MAX_TURNS:
        raise ChatError("oversized_request", f"at most {MAX_TURNS} messages")
    turns: list[dict[str, str]] = []
    for t in raw_turns:
        if not isinstance(t, dict):
            raise ChatError("malformed_payload", "each message must be an object")
        role = t.get("role")
        content = t.get("content")
        if role not in ("user", "assistant"):
            raise ChatError("malformed_payload", "message role must be user or assistant")
        if not isinstance(content, str) or not content.strip():
            raise ChatError("malformed_payload", "message content must be a non-empty string")
        if len(content) > MAX_TURN_CHARS:
            raise ChatError("oversized_request", f"message longer than {MAX_TURN_CHARS} characters")
        turns.append({"role": role, "content": content.strip()})
    if turns[-1]["role"] != "user":
        raise ChatError("malformed_payload", "the last message must be from the user")
    return report, turns


def build_messages(report_context: dict[str, Any], turns: list[dict[str, str]]) -> list[dict[str, str]]:
    """System prompt + the report as a second system turn + the conversation."""
    return [
        {"role": "system", "content": CHAT_SYSTEM_PROMPT},
        {
            "role": "system",
            "content": "The coaching report for this clip (JSON):\n" + json.dumps(report_context, ensure_ascii=False),
        },
        *turns,
    ]


def fake_reply(report_context: dict[str, Any], turns: list[dict[str, str]]) -> str:
    """Deterministic, grounded reply for the fake provider (CI / local)."""
    question = turns[-1]["content"]
    moments = report_context.get("playerSpecificObservations") or report_context.get("coachingMoments") or []
    first = moments[0] if isinstance(moments, list) and moments and isinstance(moments[0], dict) else {}
    ts = first.get("timestampSec", first.get("timestamp"))
    what = first.get("observedAction") or first.get("title") or "the first observation"
    where = f" around {ts}s" if ts is not None else ""
    return (
        f"Good question. Looking at your report, the clearest thing the sampled frames show is {what}{where}. "
        f"That is where I would start. I can only speak to what the sampled frames showed, so if your question "
        f"(\"{question[:80]}\") is about something between frames, the report will not have it."
    )
