"""Compact runtime context for analysis — approved/high only, mode-scoped."""
from __future__ import annotations

import re
from pathlib import Path
from typing import Any


MAX_CONTEXT_CHARS = 3500


def build_runtime_context(
    vault: Path,
    *,
    game_mode: str | None = None,
    max_chars: int = MAX_CONTEXT_CHARS,
) -> dict[str, Any]:
    """Select only active game + approved/high meta. Exclude candidate/disputed."""
    mode = (game_mode or "general").strip().lower()
    current_game = _read(vault / "current-game.md")
    current_meta = _read(vault / "meta" / "current-meta.md")

    mode_file = {
        "eashl": "eashl.md",
        "hut": "hut.md",
        "online versus": "online-versus.md",
        "versus": "online-versus.md",
        "online_versus": "online-versus.md",
        "offense": "offense.md",
        "defense": "defense.md",
        "goalie": "goalie.md",
        "transition": "transition.md",
    }.get(mode)

    chunks: list[str] = []
    chunks.append("## Active game\n" + _clip(current_game, 900))
    chunks.append("## Current meta index\n" + _filter_approved(_clip(current_meta, 800)))

    if mode_file:
        body = _read(vault / "meta" / mode_file)
        chunks.append(f"## Mode: {mode}\n" + _filter_approved(_clip(body, 900)))

    # Patch highlights for active slug
    slug = _detect_slug(current_game) or "nhl-26"
    patches = _read(vault / "games" / slug / "patches.md")
    chunks.append("## Patches\n" + _clip(patches, 600))

    exploits = _read(vault / "meta" / "exploits-and-counters.md")
    chunks.append("## Exploits (recognize/defend only)\n" + _filter_approved(_clip(exploits, 400)))

    text = "\n\n".join(chunks)
    text = _filter_approved(text)
    if len(text) > max_chars:
        text = text[: max_chars - 20] + "\n…[truncated]"

    return {
        "game_slug": slug,
        "game_mode": mode,
        "chars": len(text),
        "text": text,
        "excludes": ["candidate", "disputed", "unverified-only", "full-vault"],
    }


def _filter_approved(text: str) -> str:
    """Drop lines clearly marked candidate/disputed/low-only."""
    keep = []
    for line in text.splitlines():
        low = line.lower()
        if line.strip().startswith("|") and "---" not in line:
            # table data rows: keep only approved / high+corroborated-looking
            if any(s in low for s in ("| candidate |", "| disputed |", "| obsolete |", "| unverified |")):
                continue
            if "| low |" in low and "| approved |" not in low:
                continue
        if "do not use in production" in low:
            continue
        keep.append(line)
    return "\n".join(keep)


def _detect_slug(current_game_md: str) -> str | None:
    m = re.search(r"Slug\s*\|\s*`?([a-z0-9-]+)`?", current_game_md, re.I)
    if m:
        return m.group(1)
    m = re.search(r"nhl-\d+", current_game_md, re.I)
    return m.group(0).lower() if m else None


def _read(path: Path) -> str:
    if path.is_file():
        return path.read_text(encoding="utf-8", errors="replace")
    return ""


def _clip(s: str, n: int) -> str:
    s = s.strip()
    return s if len(s) <= n else s[: n - 10] + "\n…"
