"""Daily research hooks for strategy change signals + title transition helpers."""
from __future__ import annotations

import re
from typing import Any

STRATEGY_SIGNAL = re.compile(
    r"\b(meta|forecheck|breakout|neutral.?zone|power play|penalty kill|"
    r"strategy setting|tuner|gameplay (update|tune)|competitive strategy)\b",
    re.I,
)
TITLE_ANNOUNCE = re.compile(
    r"\b(announce|reveal|trailer|officially unveiled)\b.*\bnhl\b|\bnhl\b.*\b(announce|reveal)\b",
    re.I,
)
TITLE_RELEASE = re.compile(r"\b(out now|available now|released|launch)\b.*\bnhl\b|\bnhl\b.*\b(out now|released)\b", re.I)


def scan_docs_for_strategy_signals(docs: list[Any]) -> dict[str, Any]:
    hits = []
    announce = False
    release = False
    for d in docs or []:
        text = d.safe_text() if hasattr(d, "safe_text") else str(getattr(d, "snippet", d) or "")
        if STRATEGY_SIGNAL.search(text or ""):
            hits.append({"url": getattr(d, "url", ""), "excerpt": (text or "")[:160]})
        if TITLE_ANNOUNCE.search(text or ""):
            announce = True
        if TITLE_RELEASE.search(text or ""):
            release = True
    return {
        "strategy_signal": bool(hits),
        "hits": hits[:5],
        "title_announce_signal": announce,
        "title_release_signal": release,
        "deep_research_recommended": bool(hits) or announce or release,
    }


def reddit_finding_record(
    *,
    subreddit: str,
    claimed_strategy: str,
    game_title: str,
    game_mode: str = "unknown",
    benefit: str = "",
    engagement: str = "",
) -> dict[str, Any]:
    """Candidate-only structure — never approved from a single post."""
    return {
        "subreddit": subreddit,
        "gameTitle": game_title,
        "gameMode": game_mode,
        "claimedStrategy": claimed_strategy,
        "claimedBenefit": benefit,
        "engagement": engagement,
        "confidence": "unverified",
        "status": "candidate",
        "sourceType": "reddit",
        "note": "Single-community finding; requires corroboration before approval",
    }
