"""Faceoff intelligence — first-class coaching category for Scottie."""

from __future__ import annotations

FACEOFF_ZONES = frozenset(
    {"offensive", "defensive", "neutral", "power_play", "penalty_kill", "unknown"}
)

FACEOFF_MECHANICS = (
    "faceoff_draw",
    "faceoff_timing",
    "faceoff_stick_position",
    "faceoff_tie_up",
    "faceoff_win_forward",
    "faceoff_win_backhand",
    "faceoff_win_strong_side",
    "faceoff_win_weak_side",
    "faceoff_counter",
    "faceoff_grip_change",
    "faceoff_post_win_possession",
    "faceoff_post_loss_recover",
    "faceoff_winger_support",
    "faceoff_d_support",
    "faceoff_oz_set",
    "faceoff_dz_escape",
    "faceoff_nz_transition",
    "faceoff_pp_setup",
    "faceoff_pk_pressure",
)
