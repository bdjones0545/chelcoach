"""Chat with Scottie.

Two modes, both stateless on the gateway (ChelCoach keeps the turns; nothing is stored here):

- ``report`` — about one completed report. Scottie may only talk about what the sampled frames
  and the report say, and must say so when asked for more.
- ``coach`` — the standing coaching chat a player opens from the app. General NHL gameplay
  coaching is allowed; the player's latest report, when ChelCoach attaches one, is the only
  thing Scottie may claim to know about *their* play. Without one, Scottie says it has not
  seen their film and coaches in general terms.
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any

MAX_REPORT_CONTEXT_BYTES = 40_000
MAX_TURNS = 20
MAX_TURN_CHARS = 1_500
MAX_REPLY_TOKENS = 450
CHAT_MODES = ("report", "coach")

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

COACH_SYSTEM_PROMPT = """You are Scottie, the film-room coach for ChelCoach, in an ongoing conversation with a player who wants to get better at EA SPORTS NHL (NHL 27 and NHL 26; the EASHL / World of Chel modes and offline modes alike).

What you know about THIS player is limited to the coaching report attached below, if there is one. That report was built from a small number of frames sampled from one clip.

Rules:
- If a report is attached: when the player asks about their own play, answer from it and refer to moments by timestamp. Ratings and metric scores in it are estimates from sampled frames — say "estimate" when you cite them. Never invent statistics or events that are not in it.
- If no report is attached: you have not seen this player's film. Say so plainly the first time it matters, never describe or grade their play, and coach in general terms instead. When it fits, suggest uploading a clip so you can give specific feedback.
- General coaching is welcome either way: positioning, forecheck and backcheck structure, cycling, gap control, faceoffs, shot selection, transition, EASHL role play, practice habits. Be concrete and current; if unsure whether a mechanic works the same in NHL 27, say so rather than guess.
- Do not claim to know their controller inputs, settings, or anything the report does not show.
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


def validate_chat_request(body: Any) -> tuple[str, dict[str, Any] | None, list[dict[str, str]]]:
    """Bound everything the caller sends. Returns (mode, report_context, turns).

    ``report`` mode (the default, and what older callers send) requires a report. ``coach`` mode
    accepts one or none — never an empty object, which would let a caller pretend to attach one.
    """
    if not isinstance(body, dict):
        raise ChatError("malformed_payload", "Body must be an object")
    mode = body.get("mode", "report")
    if mode not in CHAT_MODES:
        raise ChatError("malformed_payload", f"mode must be one of {', '.join(CHAT_MODES)}")
    report = body.get("reportContext")
    if report is None and mode == "coach":
        report = None
    elif not isinstance(report, dict) or not report:
        raise ChatError("malformed_payload", "reportContext must be a non-empty object")
    if report is not None and len(json.dumps(report)) > MAX_REPORT_CONTEXT_BYTES:
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
    return mode, report, turns


def build_messages(
    report_context: dict[str, Any] | None,
    turns: list[dict[str, str]],
    mode: str = "report",
) -> list[dict[str, str]]:
    """System prompt (per mode) + the report as a second system turn when there is one + the conversation."""
    if mode == "coach":
        head = [{"role": "system", "content": COACH_SYSTEM_PROMPT}]
        if report_context is None:
            head.append({"role": "system", "content": "No coaching report is attached. You have not seen this player's film."})
        else:
            head.append({
                "role": "system",
                "content": "The player's latest coaching report (JSON):\n" + json.dumps(report_context, ensure_ascii=False),
            })
        return [*head, *turns]
    if report_context is None:
        raise ChatError("malformed_payload", "report mode requires a report")
    return [
        {"role": "system", "content": CHAT_SYSTEM_PROMPT},
        {
            "role": "system",
            "content": "The coaching report for this clip (JSON):\n" + json.dumps(report_context, ensure_ascii=False),
        },
        *turns,
    ]


def fake_reply(report_context: dict[str, Any] | None, turns: list[dict[str, str]], mode: str = "report") -> str:
    """Deterministic, grounded reply for the fake provider (CI / local)."""
    question = turns[-1]["content"]
    if report_context is None:
        return (
            "I have not seen your film yet, so I cannot speak to your play specifically. In general terms: "
            f"for a question like \"{question[:80]}\", start with positioning and puck support before mechanics. "
            "Upload a clip and I can point at real moments."
        )
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
