"""Control registry + lookup (cached, bounded runtime context)."""
from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

from . import CONTROL_GUIDANCE_ENABLED, PLATFORMS, PRODUCTION_STATUSES
from .schema import (
    ControlMapping,
    Drill,
    ExecutionBlock,
    parse_player_context,
    validate_mapping_dict,
)

DEFAULT_VAULT = Path("/root/Desktop/Kevin/Agents/Scottie/controls")
FIXTURE_DIR = Path(__file__).resolve().parent / "fixtures"


class ControlRegistry:
    def __init__(self, mappings: list[ControlMapping] | None = None) -> None:
        self._by_key: dict[tuple[str, str, str, str], ControlMapping] = {}
        self._all: list[ControlMapping] = []
        if mappings:
            for m in mappings:
                self.add(m)

    def add(self, m: ControlMapping) -> None:
        key = (
            _norm_title(m.game_title),
            m.platform,
            m.control_scheme,
            m.mechanic,
        )
        # conflicting: if existing production mapping differs in steps
        if key in self._by_key:
            prev = self._by_key[key]
            if prev.steps != m.steps and prev.status in PRODUCTION_STATUSES and m.status in PRODUCTION_STATUSES:
                m.status = "conflicting"
                prev.status = "conflicting"
        self._by_key[key] = m
        self._all.append(m)

    def get(
        self,
        *,
        game_title: str,
        platform: str,
        control_scheme: str,
        mechanic: str,
    ) -> ControlMapping | None:
        return self._by_key.get(
            (_norm_title(game_title), platform, control_scheme, mechanic)
        )

    def list_for_game(self, game_title: str) -> list[ControlMapping]:
        t = _norm_title(game_title)
        return [m for m in self._all if _norm_title(m.game_title) == t]

    def as_runtime_slice(
        self,
        *,
        game_title: str,
        platform: str | None,
        control_scheme: str | None,
        mechanics: list[str],
        max_chars: int = 1800,
    ) -> dict[str, Any]:
        """Compact context for analysis — only requested mechanics + verified."""
        lines = [
            f"controlContext game={game_title} platform={platform} scheme={control_scheme}",
            "Only use listed verified inputs. Do not invent buttons.",
        ]
        for mech in mechanics:
            if not platform or not control_scheme:
                lines.append(f"- {mech}: UNAVAILABLE (platform/scheme unknown)")
                continue
            m = self.get(
                game_title=game_title,
                platform=platform,
                control_scheme=control_scheme,
                mechanic=mech,
            )
            if not m or not m.production_ready():
                lines.append(f"- {mech}: UNAVAILABLE (unverified or missing)")
                continue
            step_s = " + ".join(f"{s.behavior}:{s.input}" for s in m.steps)
            lines.append(f"- {mech}: {step_s} [{m.status}]")
        text = "\n".join(lines)
        if len(text) > max_chars:
            text = text[: max_chars - 10] + "\n…"
        return {"text": text, "chars": len(text), "mechanics": mechanics}


def load_registry(
    *,
    vault_dir: Path | None = None,
    fixture_path: Path | None = None,
    include_fixtures: bool | None = None,
) -> ControlRegistry:
    """Load mappings from vault JSON + optional CI fixtures."""
    reg = ControlRegistry()
    # Fixtures: tests / when SCOTTIE_CONTROLS_USE_FIXTURES=1
    use_fix = include_fixtures
    if use_fix is None:
        use_fix = os.environ.get("SCOTTIE_CONTROLS_USE_FIXTURES", "").lower() in (
            "1",
            "true",
            "yes",
        ) or os.environ.get("SCOTTIE_TEST_MODE", "") in ("1", "true")
    if use_fix:
        fp = fixture_path or (FIXTURE_DIR / "nhl26_verified_fixture.json")
        if fp.is_file():
            _load_json_file(reg, fp)

    # Vault machine-readable pack if present
    vdir = vault_dir or DEFAULT_VAULT
    pack = vdir / "registry.json"
    if pack.is_file():
        _load_json_file(reg, pack)

    # Also load any games/*/registry.json
    games = vdir / "games"
    if games.is_dir():
        for p in games.glob("*/registry.json"):
            _load_json_file(reg, p)

    return reg


def _load_json_file(reg: ControlRegistry, path: Path) -> None:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return
    items = data if isinstance(data, list) else data.get("mappings") or data.get("controls") or []
    for raw in items:
        ok, errs, m = validate_mapping_dict(raw)
        if ok and m:
            reg.add(m)


def lookup_execution(
    reg: ControlRegistry,
    *,
    mechanic: str,
    player_context: dict[str, Any],
    game_title: str | None = None,
    enabled: bool | None = None,
    timing_cue: str | None = None,
    practice: str | None = None,
) -> ExecutionBlock:
    enabled = CONTROL_GUIDANCE_ENABLED if enabled is None else enabled
    if not enabled:
        return ExecutionBlock(available=False, reason="CONTROL_GUIDANCE_DISABLED")

    pc = parse_player_context(player_context)
    platform = pc.get("platform")
    scheme = pc.get("control_scheme") or "unknown"
    title = game_title or pc.get("game_title") or "unspecified"

    if not platform or platform not in PLATFORMS:
        return ExecutionBlock(
            available=False,
            reason="PLATFORM_UNKNOWN",
            requires_user_input=True,
        )
    if not scheme or scheme == "unknown":
        return ExecutionBlock(
            available=False,
            reason="CONTROL_SCHEME_UNKNOWN",
            requires_user_input=True,
        )

    m = reg.get(
        game_title=title,
        platform=platform,
        control_scheme=scheme,
        mechanic=mechanic,
    )
    if not m:
        return ExecutionBlock(
            available=False,
            reason="MAPPING_MISSING",
            game_title=title,
            platform=platform,
            control_scheme=scheme,
            mechanic=mechanic,
        )
    if m.status == "conflicting":
        return ExecutionBlock(
            available=False,
            reason="CONTROL_CONFLICTING",
            game_title=title,
            platform=platform,
            control_scheme=scheme,
            mechanic=mechanic,
        )
    if m.status == "deprecated":
        return ExecutionBlock(available=False, reason="CONTROL_DEPRECATED", mechanic=mechanic)
    if not m.production_ready():
        return ExecutionBlock(
            available=False,
            reason="CONTROL_UNVERIFIED",
            game_title=title,
            platform=platform,
            control_scheme=scheme,
            mechanic=mechanic,
        )

    return ExecutionBlock(
        available=True,
        game_title=m.game_title,
        platform=m.platform,
        control_scheme=m.control_scheme,
        mechanic=m.mechanic,
        inputs=[s.to_dict() for s in m.steps],
        timing_cue=timing_cue or m.timing or None,
        practice_instruction=practice,
        verified=True,
        source_confidence=m.confidence or m.status,
        control_id=m.control_id,
    )


# Recommendation → mechanics linking for meta/coaching
MECHANIC_KEYWORDS: list[tuple[str, list[str]]] = [
    (r"protect(ing)? (the )?puck|puck protection|shield", ["protect_puck", "zone_entry_protect"]),
    (r"hustle|speed burst|sprint", ["hustle"]),
    (r"poke check|pokecheck", ["poke_check"]),
    (r"stick lift", ["stick_lift"]),
    (r"body check|hit\b|hitting", ["body_check"]),
    (r"one[- ]timer", ["one_timer"]),
    (r"wrist shot", ["wrist_shot"]),
    (r"slap shot", ["slap_shot"]),
    (r"deke|dangle", ["deke"]),
    (r"saucer", ["saucer_pass"]),
    (r"\bpass\b|passing", ["pass"]),
    (r"cut ?back", ["cutback", "protect_puck"]),
    (r"block shot|shot block", ["block_shot"]),
    (r"line change", ["line_change"]),
    (r"dump", ["dump_puck"]),
    (r"faceoff", ["faceoff_draw"]),
]


def infer_mechanics_from_text(*texts: str) -> list[str]:
    import re

    blob = " ".join(t for t in texts if t).lower()
    found: list[str] = []
    for pat, mechs in MECHANIC_KEYWORDS:
        if re.search(pat, blob, re.I):
            for m in mechs:
                if m not in found:
                    found.append(m)
    return found[:4]


def build_drill_for_mechanic(
    mechanic: str,
    *,
    platform: str | None,
    control_scheme: str | None,
    execution: ExecutionBlock | None = None,
) -> Drill:
    names = {
        "protect_puck": (
            "Protected Zone Entry",
            "Enter wide while shielding the puck from contact.",
            "Maintain possession through the blue line and create a pass/shot option.",
            "Dropping protect too early on contact",
        ),
        "poke_check": (
            "Gap Poke Timing",
            "Keep a tight gap and poke when the carrier commits.",
            "Force a bobble without taking a penalty animation.",
            "Lunging from too far",
        ),
        "hustle": (
            "First-Three-Strides Hustle",
            "Win the first three strides out of a stop or turn.",
            "Reach a support spot before the defender closes.",
            "Holding hustle into fatigue/useless angles",
        ),
        "cutback": (
            "Outside Cutback",
            "Attack wide then cut back against overcommit.",
            "Create inside ice after the defender slides past.",
            "Telegraphing the cut with no protect",
        ),
    }
    name, obj, success, mistake = names.get(
        mechanic,
        (
            f"{mechanic.replace('_', ' ').title()} Reps",
            f"Practice the {mechanic.replace('_', ' ')} mechanic cleanly.",
            "Complete clean repetitions without losing possession unnecessarily.",
            "Rushing inputs out of timing",
        ),
    )
    controls = execution.inputs if execution and execution.available else []
    return Drill(
        drill_name=name,
        objective=obj,
        platform=platform,
        control_scheme=control_scheme,
        controls=controls,
        repetitions=10,
        success_condition=success,
        starting_position="neutral zone / blue line as applicable",
        common_mistake=mistake,
        progression="Add a passive defender after 5 clean reps",
        game_mode="practice / free skate",
    )


def attach_execution_to_report(
    report: dict[str, Any],
    *,
    reg: ControlRegistry,
    player_context: dict[str, Any],
    game_title: str,
    enabled: bool | None = None,
) -> dict[str, Any]:
    """Mutate/return report with execution blocks + controlContext + optional drills."""
    enabled = CONTROL_GUIDANCE_ENABLED if enabled is None else enabled
    out = dict(report)
    pc = parse_player_context(player_context)
    platform = pc.get("platform")
    scheme = pc.get("control_scheme")

    out["controlContext"] = {
        "gameTitle": game_title,
        "platform": platform,
        "controlScheme": scheme,
        "guidanceEnabled": bool(enabled),
        "verifiedAt": None,
    }

    if not enabled:
        return out

    moments = out.get("coachingMoments") or []
    if not isinstance(moments, list):
        return out

    drills: list[dict[str, Any]] = []
    verified_any = None
    new_moments = []
    for m in moments:
        if not isinstance(m, dict):
            continue
        mm = dict(m)
        texts = [
            str(mm.get("title") or ""),
            str(mm.get("teaser") or ""),
            str(mm.get("fullBreakdown") or ""),
            str(mm.get("observedAction") or ""),
        ]
        mechs = infer_mechanics_from_text(*texts)
        if not mechs:
            mm["execution"] = ExecutionBlock(
                available=False, reason="NO_SPECIFIC_MECHANIC"
            ).to_dict()
            new_moments.append(mm)
            continue
        # primary mechanic
        primary = mechs[0]
        ex = lookup_execution(
            reg,
            mechanic=primary,
            player_context=player_context,
            game_title=game_title,
            enabled=enabled,
            timing_cue=mm.get("timingCue"),
            practice=None,
        )
        mm["execution"] = ex.to_dict()
        if ex.available:
            verified_any = ex.verified and ex.source_confidence
            drill = build_drill_for_mechanic(
                primary, platform=platform, control_scheme=scheme, execution=ex
            )
            drills.append(drill.to_dict())
        new_moments.append(mm)

    out["coachingMoments"] = new_moments
    if drills:
        # max 3 drills
        out["practiceDrills"] = drills[:3]
    if verified_any:
        out["controlContext"]["verifiedAt"] = "fixture-or-registry"
        out["controlContext"]["sourceConfidence"] = verified_any
    return out


def _norm_title(t: str) -> str:
    return " ".join(str(t or "").lower().replace("ea sports", "").split())
