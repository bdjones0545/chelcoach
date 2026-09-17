"""chelcoach-rubric-v1 — NHL gameplay coaching rubric."""
from __future__ import annotations

from typing import Any

RUBRIC_VERSION = "chelcoach-rubric-v1"

METRICS: dict[str, dict[str, Any]] = {
    "offensive_positioning": {
        "label": "Offensive Positioning",
        "description": (
            "Support angles, net-front / slot presence, weak-side availability, "
            "cycle depth, and high-danger ice occupancy when the team has possession in the OZ."
        ),
        "observable_cues": [
            "Player location relative to puck, net, and slot",
            "Open ice vs. covered by defenders",
            "Timing of arrivals to scoring areas",
            "Board vs. middle ice choice with puck",
        ],
        "weight": 1.0,
    },
    "defensive_positioning": {
        "label": "Defensive Positioning",
        "description": (
            "Gap control, box/slot protection, stick position, board-side support, "
            "and recovery routes without the puck."
        ),
        "observable_cues": [
            "Distance/angle to puck carrier",
            "Slot coverage and net-front presence",
            "Over-commit vs. middle-lane hold",
            "Backcheck lane choice",
        ],
        "weight": 1.0,
    },
    "decision_making": {
        "label": "Decision Making",
        "description": (
            "Quality of reads: pass vs. shoot vs. hold, when to pressure, when to delay, "
            "and choice under visible pressure."
        ),
        "observable_cues": [
            "Puck choices at reception",
            "Pressure response (chip, pass, reverse, skate)",
            "Foresight implied by body orientation before reception",
            "Risk/reward of stretch plays vs. support options",
        ],
        "weight": 1.1,
    },
    "puck_movement": {
        "label": "Puck Movement",
        "description": (
            "Pass selection, reception cleanliness, pace of distribution, and ability to "
            "move the puck through layers without unnecessary carries."
        ),
        "observable_cues": [
            "Pass targets available vs. chosen",
            "Puck reception stability",
            "Dwell time before first touch decision",
            "Cross-ice / seam attempts when lanes open",
        ],
        "weight": 1.0,
    },
    "spacing": {
        "label": "Spacing",
        "description": (
            "Distance maintenance with teammates, stretch of the defensive structure, "
            "avoiding bunching, and creating lanes."
        ),
        "observable_cues": [
            "Inter-player distance clusters",
            "Lane openness created or collapsed",
            "Support distance for outlets",
            "NZ and OZ structure shape",
        ],
        "weight": 0.9,
    },
    "transition_play": {
        "label": "Transition Play",
        "description": (
            "DZ exits, NZ entries, regroup quality, retrieval-to-exit sequences, "
            "and defensive-to-offensive conversion paths."
        ),
        "observable_cues": [
            "Controlled vs. dump exits",
            "NZ speed and support structure",
            "Entry method (carry, chip, dump)",
            "Immediate F1/F2/F3 or D roles after change of possession",
        ],
        "weight": 1.1,
    },
}


def chel_rating_from_metrics(metrics: dict[str, int | float]) -> int:
    """Weighted average of 0–100 metrics → 0–1000 Chel Rating."""
    num = 0.0
    den = 0.0
    for key, meta in METRICS.items():
        if key not in metrics:
            continue
        w = float(meta["weight"])
        v = max(0.0, min(100.0, float(metrics[key])))
        num += v * w
        den += w
    if den <= 0:
        return 0
    # Map 0–100 average to 0–1000
    return int(round((num / den) * 10))


def percentile_label(chel_rating: int) -> str:
    """Honest band label — not a claim about a real population distribution."""
    if chel_rating >= 900:
        return "Elite band (estimate)"
    if chel_rating >= 800:
        return "High band (estimate)"
    if chel_rating >= 700:
        return "Above-average band (estimate)"
    if chel_rating >= 600:
        return "Average band (estimate)"
    if chel_rating >= 500:
        return "Developing band (estimate)"
    return "Foundational band (estimate)"


def rubric_prompt_block() -> str:
    lines = [
        f"Rubric version: {RUBRIC_VERSION}",
        "Score each metric 0–100 using only Directly Observable or Reasonable Inference evidence.",
        "Chel Rating is derived server-side from weighted metrics (do not invent population stats).",
        "",
    ]
    for key, meta in METRICS.items():
        lines.append(f"### {meta['label']} (`{key}`)")
        lines.append(meta["description"])
        lines.append("Observable cues: " + "; ".join(meta["observable_cues"]))
        lines.append("")
    return "\n".join(lines)
