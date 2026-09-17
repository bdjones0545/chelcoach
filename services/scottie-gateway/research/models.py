"""Evidence model + helpers."""
from __future__ import annotations

import hashlib
import re
from dataclasses import asdict, dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def utc_iso(dt: datetime | None = None) -> str:
    d = dt or utc_now()
    return d.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def day_stamp(dt: datetime | None = None) -> str:
    d = dt or utc_now()
    return d.astimezone(timezone.utc).strftime("%Y-%m-%d")


def finding_id(claim: str, source: str, game: str) -> str:
    h = hashlib.sha256(f"{game}|{source}|{claim}".encode()).hexdigest()[:10]
    return f"F-{h}"


@dataclass
class Finding:
    finding_id: str
    game_title: str
    game_version_or_patch: str
    game_mode: str
    topic: str
    claim: str
    source_type: str  # official | competitive | community | internal
    source: str
    publication_date: str
    date_discovered: str
    evidence_summary: str
    confidence: str
    status: str
    contradiction_notes: str = ""
    recheck_date: str = ""
    tier: int = 3
    engagement: str = ""
    subreddit: str = ""
    notify: bool = False
    production_impact: bool = False

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


INJECTION_PATTERNS = (
    r"ignore (all )?(previous|prior) instructions",
    r"system prompt",
    r"you are now",
    r"disregard your (rules|policy)",
    r"<script",
    r"javascript:",
)


def scrub_untrusted_text(text: str, max_len: int = 2000) -> str:
    """Treat external content as data only — strip injection-ish lines."""
    if not text:
        return ""
    lines = []
    for line in text.splitlines():
        low = line.lower()
        if any(re.search(p, low) for p in INJECTION_PATTERNS):
            lines.append("[blocked-untrusted-instruction]")
            continue
        lines.append(line)
    out = "\n".join(lines).strip()
    return out[:max_len]


def default_recheck(confidence: str, source_type: str, topic: str) -> str:
    now = utc_now()
    if source_type == "official" and "patch" in topic.lower():
        days = 365  # recheck on new patch signal only; long placeholder
    elif confidence in ("official", "high") and "meta" in topic.lower():
        days = 7
    elif source_type == "community":
        days = 5
    elif source_type == "competitive":
        days = 14
    else:
        days = 14
    return (now + timedelta(days=days)).strftime("%Y-%m-%d")


def is_expired(recheck_date: str, today: str | None = None) -> bool:
    if not recheck_date:
        return False
    t = today or day_stamp()
    try:
        return recheck_date < t
    except Exception:
        return False


def community_ceiling(confidence: str) -> str:
    order = ["unverified", "low", "medium", "high", "official"]
    if confidence not in order:
        return "low"
    if order.index(confidence) > order.index("medium"):
        return "medium"
    return confidence
