"""Bounded control-change detection for daily research loop."""
from __future__ import annotations

import re
from typing import Any


CONTROL_SIGNAL = re.compile(
    r"\b(control(ler)? (layout|scheme|settings)|skill stick|total control|"
    r"button remapp|remapped|new mechanic|accessibility control)\b",
    re.I,
)


def scan_docs_for_control_signals(docs: list[Any]) -> dict[str, Any]:
    """Return whether deep control research is warranted (still no auto-approve)."""
    hits = []
    for d in docs or []:
        text = ""
        if hasattr(d, "safe_text"):
            text = d.safe_text()
        elif isinstance(d, dict):
            text = f"{d.get('title','')} {d.get('snippet','')}"
        else:
            text = str(d)
        if CONTROL_SIGNAL.search(text or ""):
            hits.append(
                {
                    "url": getattr(d, "url", None) or (d.get("url") if isinstance(d, dict) else ""),
                    "excerpt": (text or "")[:180],
                }
            )
    return {
        "control_change_signal": bool(hits),
        "hits": hits[:5],
        "deep_research_recommended": bool(hits),
        "note": (
            "Deep control verification required before production mappings"
            if hits
            else "No control-change signal in bounded sources"
        ),
    }
