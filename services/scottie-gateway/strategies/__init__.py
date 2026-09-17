"""Versioned gameplay strategy intelligence for Scottie."""
from __future__ import annotations

import os

STRATEGY_GUIDANCE_ENABLED = os.environ.get("SCOTTIE_STRATEGY_GUIDANCE_ENABLED", "false").lower() in (
    "1",
    "true",
    "yes",
    "on",
)

CATEGORIES = frozenset(
    {
        "zone_entry",
        "offensive_zone",
        "rush_offense",
        "breakout",
        "breakout_support",
        "defensive_zone",
        "rush_defense",
        "neutral_zone",
        "forecheck",
        "transition",
        "power_play",
        "penalty_kill",
        "faceoff_strategy",
        "game_state",
        "position_specific",
    }
)

CLASS_LABELS = frozenset(
    {"fundamental", "current_meta", "situational", "experimental", "legacy", "obsolete"}
)
CONFIDENCE = frozenset({"official", "high", "medium", "low", "unverified", "conflicting"})
STATUSES = frozenset(
    {"approved", "candidate", "verification_required", "pending_bryan_review", "archived", "obsolete"}
)
POSITIONS = frozenset({"C", "LW", "RW", "LD", "RD", "G", "UNKNOWN"})

# Freshness days by class / source
FRESHNESS_DAYS = {
    "current_meta": 7,
    "fundamental": 90,
    "situational": 14,
    "experimental": 7,
    "legacy": 3650,
    "obsolete": 3650,
    "reddit": 5,
    "creator": 14,
    "official": 365,
}
