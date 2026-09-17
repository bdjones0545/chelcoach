"""Control schemas + validation."""
from __future__ import annotations

import re
from dataclasses import asdict, dataclass, field
from typing import Any

from . import (
    ALL_STATUSES,
    CANONICAL_ACTIONS,
    CONTROL_SCHEMES,
    PLATFORMS,
    PRODUCTION_STATUSES,
    PS_BUTTONS,
    XBOX_BUTTONS,
)


@dataclass
class InputStep:
    order: int
    input: str
    behavior: str = "press"  # tap|hold|press|release|motion|modifier
    duration_ms: int | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "order": self.order,
            "input": self.input,
            "behavior": self.behavior,
            "durationMs": self.duration_ms,
        }


@dataclass
class ControlMapping:
    control_id: str
    game_title: str
    platform: str
    control_scheme: str
    game_mode: str
    player_role: str
    mechanic: str  # canonical action_id
    steps: list[InputStep]
    timing: str = ""
    left_stick: str | None = None
    right_stick: str | None = None
    source_type: str = "unverified"
    source_ref: str = ""
    verified_at: str = ""
    confidence: str = "unverified"
    status: str = "verification_required"
    game_version: str = ""
    patch_version: str = ""
    notes: str = ""

    def to_dict(self) -> dict[str, Any]:
        d = asdict(self)
        d["steps"] = [s.to_dict() if isinstance(s, InputStep) else s for s in self.steps]
        # public camelCase for API
        return {
            "controlId": self.control_id,
            "gameTitle": self.game_title,
            "platform": self.platform,
            "controlScheme": self.control_scheme,
            "gameMode": self.game_mode,
            "playerRole": self.player_role,
            "mechanic": self.mechanic,
            "input": {
                "steps": [s.to_dict() if isinstance(s, InputStep) else s for s in self.steps],
                "leftStick": self.left_stick,
                "rightStick": self.right_stick,
            },
            "timing": self.timing,
            "sourceType": self.source_type,
            "sourceRef": self.source_ref,
            "verifiedAt": self.verified_at,
            "confidence": self.confidence,
            "status": self.status,
            "gameVersion": self.game_version,
            "patchVersion": self.patch_version,
            "notes": self.notes,
        }

    def production_ready(self) -> bool:
        return self.status in PRODUCTION_STATUSES and bool(self.steps)


def parse_player_context(raw: dict[str, Any] | None) -> dict[str, Any]:
    """Extract platform/scheme/position/mode from job input. Reject junk safely."""
    raw = raw or {}
    # nested playerContext preferred
    pc = raw.get("playerContext") if isinstance(raw.get("playerContext"), dict) else raw
    if not isinstance(pc, dict):
        pc = {}
    # also allow gameplayContext merge by caller
    platform = str(pc.get("platform") or "").strip().lower().replace("-", "_").replace(" ", "_")
    # normalize aliases
    aliases = {
        "ps5": "playstation_5",
        "playstation5": "playstation_5",
        "ps4": "playstation_4",
        "playstation4": "playstation_4",
        "xbox": "xbox_series",
        "xbox_series_x": "xbox_series",
        "xbox_series_s": "xbox_series",
        "xboxseries": "xbox_series",
        "xboxone": "xbox_one",
        "xbox_one_x": "xbox_one",
    }
    platform = aliases.get(platform, platform)
    scheme = str(pc.get("controlScheme") or pc.get("control_scheme") or "unknown").strip().lower().replace(" ", "_")
    scheme_aliases = {
        "totalcontrol": "total_control",
        "skillstick": "skill_stick",
        "skill": "skill_stick",
        "total": "total_control",
    }
    scheme = scheme_aliases.get(scheme, scheme)
    position = str(pc.get("position") or "").strip().upper() or None
    game_mode = str(pc.get("gameMode") or pc.get("game_mode") or "").strip().lower() or None
    game_title = str(pc.get("gameTitle") or pc.get("game_title") or "").strip() or None
    out = {
        "platform": platform or None,
        "control_scheme": scheme if scheme else "unknown",
        "position": position,
        "game_mode": game_mode,
        "game_title": game_title,
        "controller_type": pc.get("controllerType") or pc.get("controller_type"),
    }
    return out


def validate_mapping_dict(raw: dict[str, Any]) -> tuple[bool, list[str], ControlMapping | None]:
    errs: list[str] = []
    if not isinstance(raw, dict):
        return False, ["not_object"], None
    platform = str(raw.get("platform") or "")
    scheme = str(raw.get("controlScheme") or raw.get("control_scheme") or "")
    mechanic = str(raw.get("mechanic") or raw.get("action_id") or "")
    status = str(raw.get("status") or "unverified")
    if platform not in PLATFORMS:
        errs.append(f"unsupported_platform:{platform}")
    if scheme not in CONTROL_SCHEMES and scheme != "unknown":
        errs.append(f"unsupported_scheme:{scheme}")
    if mechanic not in CANONICAL_ACTIONS:
        errs.append(f"unknown_mechanic:{mechanic}")
    if status not in ALL_STATUSES:
        errs.append(f"bad_status:{status}")

    steps_raw = []
    inp = raw.get("input") if isinstance(raw.get("input"), dict) else {}
    if raw.get("steps"):
        steps_raw = raw["steps"]
    elif inp.get("steps"):
        steps_raw = inp["steps"]
    elif inp.get("buttons"):
        # legacy simple form
        beh = inp.get("behavior") or "press"
        steps_raw = [{"order": i + 1, "input": b, "behavior": beh} for i, b in enumerate(inp["buttons"])]

    steps: list[InputStep] = []
    if not isinstance(steps_raw, list):
        errs.append("steps_not_list")
        steps_raw = []
    for i, s in enumerate(steps_raw):
        if not isinstance(s, dict):
            errs.append(f"step[{i}]_not_object")
            continue
        label = str(s.get("input") or "")
        if not label:
            errs.append(f"step[{i}]_empty_input")
            continue
        # platform label hygiene
        if platform.startswith("xbox") and label in PS_BUTTONS - {"D-PAD_UP", "D-PAD_DOWN", "D-PAD_LEFT", "D-PAD_RIGHT"}:
            errs.append(f"step[{i}]_ps_label_on_xbox:{label}")
        if platform.startswith("playstation") and label in XBOX_BUTTONS - {
            "D-PAD_UP",
            "D-PAD_DOWN",
            "D-PAD_LEFT",
            "D-PAD_RIGHT",
            "LS",
            "RS",
        }:
            # Xbox A/B/X/Y/LB etc on PS is wrong
            if label in {"A", "B", "X", "Y", "LB", "RB", "LT", "RT"}:
                errs.append(f"step[{i}]_xbox_label_on_ps:{label}")
        # reject placeholders
        if re.search(r"VERIFIED_BUTTON|TODO|PLACEHOLDER|TBD", label, re.I):
            errs.append(f"step[{i}]_placeholder:{label}")
        steps.append(
            InputStep(
                order=int(s.get("order") or i + 1),
                input=label,
                behavior=str(s.get("behavior") or "press"),
                duration_ms=s.get("durationMs", s.get("duration_ms")),
            )
        )

    if status in PRODUCTION_STATUSES and not steps:
        errs.append("production_status_requires_steps")

    if errs:
        return False, errs, None

    cid = str(
        raw.get("controlId")
        or raw.get("control_id")
        or f"{_slug(raw.get('gameTitle'))}-{platform}-{scheme}-{mechanic}"
    )
    m = ControlMapping(
        control_id=cid,
        game_title=str(raw.get("gameTitle") or raw.get("game_title") or ""),
        platform=platform,
        control_scheme=scheme,
        game_mode=str(raw.get("gameMode") or raw.get("game_mode") or "all"),
        player_role=str(raw.get("playerRole") or raw.get("player_role") or "skater"),
        mechanic=mechanic,
        steps=steps,
        timing=str(raw.get("timing") or ""),
        left_stick=inp.get("leftStick") or raw.get("leftStick"),
        right_stick=inp.get("rightStick") or raw.get("rightStick"),
        source_type=str(raw.get("sourceType") or raw.get("source_type") or "unverified"),
        source_ref=str(raw.get("sourceRef") or raw.get("source_ref") or ""),
        verified_at=str(raw.get("verifiedAt") or raw.get("verified_at") or ""),
        confidence=str(raw.get("confidence") or status),
        status=status,
        game_version=str(raw.get("gameVersion") or ""),
        patch_version=str(raw.get("patchVersion") or ""),
        notes=str(raw.get("notes") or ""),
    )
    return True, [], m


def _slug(s: Any) -> str:
    return re.sub(r"[^a-z0-9]+", "-", str(s or "game").lower()).strip("-") or "game"


@dataclass
class ExecutionBlock:
    available: bool
    reason: str | None = None
    requires_user_input: bool = False
    game_title: str | None = None
    platform: str | None = None
    control_scheme: str | None = None
    mechanic: str | None = None
    inputs: list[dict[str, Any]] = field(default_factory=list)
    timing_cue: str | None = None
    practice_instruction: str | None = None
    verified: bool = False
    source_confidence: str | None = None
    control_id: str | None = None

    def to_dict(self) -> dict[str, Any]:
        if not self.available:
            return {
                "executionAvailable": False,
                "reason": self.reason or "UNAVAILABLE",
                "requiresUserInput": self.requires_user_input,
            }
        return {
            "executionAvailable": True,
            "gameTitle": self.game_title,
            "platform": self.platform,
            "controlScheme": self.control_scheme,
            "mechanic": self.mechanic,
            "inputs": self.inputs,
            "timingCue": self.timing_cue,
            "practiceInstruction": self.practice_instruction,
            "verified": self.verified,
            "sourceConfidence": self.source_confidence,
            "controlId": self.control_id,
        }


@dataclass
class Drill:
    drill_name: str
    objective: str
    platform: str | None
    control_scheme: str | None
    controls: list[dict[str, Any]]
    repetitions: int
    success_condition: str
    starting_position: str = ""
    common_mistake: str = ""
    progression: str = ""
    game_mode: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "drillName": self.drill_name,
            "objective": self.objective,
            "platform": self.platform,
            "controlScheme": self.control_scheme,
            "controls": self.controls,
            "repetitions": self.repetitions,
            "successCondition": self.success_condition,
            "startingPosition": self.starting_position,
            "commonMistake": self.common_mistake,
            "progression": self.progression,
            "gameMode": self.game_mode,
        }
