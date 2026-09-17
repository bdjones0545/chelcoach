"""Scottie Control Intelligence — verified platform inputs for coaching execution."""

__version__ = "1.0.0"

# Feature flag — default OFF
import os

CONTROL_GUIDANCE_ENABLED = os.environ.get("SCOTTIE_CONTROL_GUIDANCE_ENABLED", "false").lower() in (
    "1",
    "true",
    "yes",
    "on",
)

PLATFORMS = frozenset({"xbox_series", "xbox_one", "playstation_5", "playstation_4"})
CONTROL_SCHEMES = frozenset({"total_control", "skill_stick", "hybrid", "goalie_default", "unknown"})
PRODUCTION_STATUSES = frozenset({"official", "in_game_verified"})
ALL_STATUSES = frozenset(
    {
        "official",
        "in_game_verified",
        "community_corroborated",
        "unverified",
        "conflicting",
        "deprecated",
        "verification_required",
    }
)

XBOX_BUTTONS = frozenset(
    {"A", "B", "X", "Y", "LB", "RB", "LT", "RT", "LS", "RS", "D-PAD_UP", "D-PAD_DOWN", "D-PAD_LEFT", "D-PAD_RIGHT"}
)
PS_BUTTONS = frozenset(
    {
        "Cross",
        "Circle",
        "Square",
        "Triangle",
        "L1",
        "R1",
        "L2",
        "R2",
        "L3",
        "R3",
        "D-PAD_UP",
        "D-PAD_DOWN",
        "D-PAD_LEFT",
        "D-PAD_RIGHT",
    }
)

CANONICAL_ACTIONS = (
    "pass",
    "saucer_pass",
    "shoot",
    "wrist_shot",
    "slap_shot",
    "snap_shot",
    "one_timer",
    "deke",
    "protect_puck",
    "hustle",
    "reverse_hit",
    "body_check",
    "poke_check",
    "stick_lift",
    "tie_up",
    "block_shot",
    "crouch_block",
    "switch_player",
    "call_for_pass",
    "vision_control",
    "line_change",
    "dump_puck",
    "board_play",
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
    "cutback",
    "zone_entry_protect",
    "goalie_move",
    "goalie_poke",
    "goalie_cover",
)
