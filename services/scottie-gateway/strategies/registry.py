"""Strategy registry, runtime context, report attachment, drills, release transition."""
from __future__ import annotations

import json
import os
import re
from pathlib import Path
from typing import Any

from . import STRATEGY_GUIDANCE_ENABLED
from .schema import StrategyRecord, parse_iso, utc_now, validate_strategy_dict

DEFAULT_VAULT = Path("/root/Desktop/Kevin/Agents/Scottie")
FIXTURE_DIR = Path(__file__).resolve().parent / "fixtures"

MAX_RUNTIME_CHARS = 2200
MAX_STRATEGIES_IN_CONTEXT = 6


class StrategyRegistry:
    def __init__(self) -> None:
        self._all: list[StrategyRecord] = []
        self._by_id: dict[str, StrategyRecord] = {}

    def add(self, rec: StrategyRecord) -> None:
        # conflict: same id different content
        if rec.strategy_id in self._by_id:
            prev = self._by_id[rec.strategy_id]
            if prev.objective != rec.objective and prev.status == "approved" and rec.status == "approved":
                rec.confidence = "conflicting"
                prev.confidence = "conflicting"
                rec.status = "candidate"
        self._by_id[rec.strategy_id] = rec
        self._all = [r for r in self._all if r.strategy_id != rec.strategy_id]
        self._all.append(rec)

    def get(self, strategy_id: str) -> StrategyRecord | None:
        return self._by_id.get(strategy_id)

    def list_for_game(self, game_title: str) -> list[StrategyRecord]:
        t = _norm_title(game_title)
        return [r for r in self._all if _norm_title(r.game_title) == t]

    def query(
        self,
        *,
        game_title: str,
        category: str | None = None,
        position: str | None = None,
        zone: str | None = None,
        game_mode: str | None = None,
        game_state: str | None = None,
        classification: str | None = None,
        production_only: bool = False,
        include_legacy: bool = False,
    ) -> list[StrategyRecord]:
        out = []
        for r in self.list_for_game(game_title):
            if not include_legacy and r.classification == "legacy":
                continue
            if r.classification == "obsolete" or r.status in ("obsolete", "archived"):
                continue
            if production_only and not r.production_ready():
                continue
            if category and r.category != category and r.category != "position_specific":
                continue
            if position and r.position not in (position.upper(), "UNKNOWN") and r.position != "ALL":
                # allow UNKNOWN records as general
                if r.position not in ("UNKNOWN", position.upper()):
                    continue
            if zone and r.zone not in (zone, "all", "any"):
                continue
            if game_mode and r.game_mode not in (game_mode.lower(), "all"):
                continue
            if game_state and r.game_state not in (game_state, "any", "all"):
                continue
            if classification and r.classification != classification:
                continue
            out.append(r)
        # prefer approved current_meta then fundamental
        rank = {"current_meta": 0, "situational": 1, "fundamental": 2, "experimental": 3, "legacy": 4}
        out.sort(key=lambda x: (0 if x.production_ready() else 1, rank.get(x.classification, 5)))
        return out


def load_registry(
    *,
    vault_dir: Path | None = None,
    include_fixtures: bool | None = None,
) -> StrategyRegistry:
    reg = StrategyRegistry()
    use_fix = include_fixtures
    if use_fix is None:
        use_fix = os.environ.get("SCOTTIE_STRATEGIES_USE_FIXTURES", "").lower() in (
            "1",
            "true",
            "yes",
        ) or os.environ.get("SCOTTIE_TEST_MODE", "") in ("1", "true")
    if use_fix:
        fp = FIXTURE_DIR / "nhl26_strategies_fixture.json"
        if fp.is_file():
            _load_json(reg, fp)
    vdir = vault_dir or DEFAULT_VAULT
    pack = vdir / "games" / "nhl-26" / "strategies" / "registry.json"
    if pack.is_file():
        _load_json(reg, pack)
    # any games/*/strategies/registry.json
    games = vdir / "games"
    if games.is_dir():
        for p in games.glob("*/strategies/registry.json"):
            _load_json(reg, p)
    return reg


def _load_json(reg: StrategyRegistry, path: Path) -> None:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return
    items = data if isinstance(data, list) else data.get("strategies") or data.get("mappings") or []
    for raw in items:
        ok, _, rec = validate_strategy_dict(raw)
        if ok and rec:
            reg.add(rec)


def create_game_namespace(vault_dir: Path, game_slug: str, game_title: str) -> Path:
    """Create empty versioned namespace; inherit strategies as verification_required."""
    root = vault_dir / "games" / game_slug
    for sub in (
        "controls",
        "faceoffs",
        "strategies",
        "meta",
    ):
        (root / sub).mkdir(parents=True, exist_ok=True)
    for f in (
        "offense.md",
        "defense.md",
        "neutral-zone.md",
        "forecheck.md",
        "breakouts.md",
        "transition.md",
        "power-play.md",
        "penalty-kill.md",
        "game-state.md",
        "position-specific.md",
        "faceoffs.md",
    ):
        p = root / "strategies" / f
        if not p.exists():
            p.write_text(f"# {game_title} — {f}\n\nStatus: verification_required\n", encoding="utf-8")
    for f in ("current-meta.md", "candidate-findings.md", "counters.md", "obsolete-strategies.md"):
        p = root / "meta" / f
        if not p.exists():
            p.write_text(f"# {game_title} — {f}\n\n", encoding="utf-8")
    overview = root / "overview.md"
    if not overview.exists():
        overview.write_text(
            f"# {game_title}\n\n**Slug:** `{game_slug}`\n**Status:** namespace created; strategies verification_required\n",
            encoding="utf-8",
        )
    # empty registry with note
    regp = root / "strategies" / "registry.json"
    if not regp.exists():
        regp.write_text(
            json.dumps(
                {
                    "gameTitle": game_title,
                    "strategies": [],
                    "note": "Inherited knowledge must be re-verified; do not copy as approved.",
                },
                indent=2,
            ),
            encoding="utf-8",
        )
    return root


def inherit_as_verification_required(
    source: StrategyRegistry, *, from_title: str, to_title: str
) -> list[StrategyRecord]:
    """Clone strategies into new title with verification_required (not approved)."""
    out = []
    for r in source.list_for_game(from_title):
        if r.classification == "obsolete":
            continue
        d = r.to_dict()
        d["strategyId"] = r.strategy_id.replace(_slug_title(from_title), _slug_title(to_title))
        if d["strategyId"] == r.strategy_id:
            d["strategyId"] = f"{_slug_title(to_title)}-{r.strategy_id}"
        d["gameTitle"] = to_title
        d["status"] = "verification_required"
        d["classification"] = "experimental" if r.classification == "current_meta" else r.classification
        if d["classification"] == "current_meta":
            d["classification"] = "experimental"
        d["confidence"] = "unverified"
        d["notes"] = f"inherited_from={r.strategy_id}; requires verification"
        ok, _, rec = validate_strategy_dict(d)
        if ok and rec:
            out.append(rec)
    return out


def build_runtime_context(
    reg: StrategyRegistry,
    *,
    game_title: str,
    position: str | None,
    game_mode: str | None,
    zone: str | None,
    game_state: str | None,
    categories: list[str] | None = None,
    skill_level: str = "all",
    max_chars: int = MAX_RUNTIME_CHARS,
) -> dict[str, Any]:
    cats = categories or []
    picked: list[StrategyRecord] = []
    if cats:
        for c in cats:
            picked.extend(
                reg.query(
                    game_title=game_title,
                    category=c,
                    position=position,
                    zone=zone,
                    game_mode=game_mode,
                    game_state=game_state,
                    production_only=True,
                )[:2]
            )
    else:
        picked = reg.query(
            game_title=game_title,
            position=position,
            zone=zone,
            game_mode=game_mode,
            game_state=game_state,
            production_only=True,
        )[:MAX_STRATEGIES_IN_CONTEXT]

    # dedupe
    seen = set()
    uniq = []
    for r in picked:
        if r.strategy_id in seen:
            continue
        seen.add(r.strategy_id)
        # skill filter
        if skill_level == "beginner" and r.skill_level == "advanced":
            continue
        uniq.append(r)
        if len(uniq) >= MAX_STRATEGIES_IN_CONTEXT:
            break

    lines = [
        f"strategyContext game={game_title} pos={position} mode={game_mode} zone={zone} state={game_state}",
        "Use only listed approved strategies. Do not invent team systems from one frame.",
        "Attribute only controlled-player responsibilities.",
    ]
    for r in uniq:
        resp = "; ".join(r.player_responsibility[:3])
        lines.append(
            f"- [{r.classification}/{r.category}] {r.strategy_name}: {r.objective[:120]} | you: {resp[:160]}"
        )
    text = "\n".join(lines)
    if len(text) > max_chars:
        text = text[: max_chars - 10] + "\n…"
    return {
        "text": text,
        "chars": len(text),
        "strategyIds": [r.strategy_id for r in uniq],
        "count": len(uniq),
    }


# Observation text → category inference
CATEGORY_PATTERNS: list[tuple[str, str]] = [
    (r"breakout|outlet|d.?to.?d", "breakout_support"),
    (r"forecheck|1-2-2|2-1-2|1-3-1", "forecheck"),
    (r"gap control|backcheck|rush defense|entry denial", "rush_defense"),
    (r"zone entry|enter(ed|ing) the zone|controlled entry|dump.?and.?chase|cutback", "zone_entry"),
    (r"cycle|net.?front|low.?to.?high|umbrella|one.?timer|slot", "offensive_zone"),
    (r"neutral.?zone|trap|regroup", "neutral_zone"),
    (r"power play|on the pp|pp setup", "power_play"),
    (r"penalty kill|\bpk\b|shorthanded", "penalty_kill"),
    (r"faceoff|face.?off|the draw", "faceoff_strategy"),
    (r"transition|counter.?attack", "transition"),
    (r"defensive zone|in the d.?zone|coverage|collapse|slot protect", "defensive_zone"),
]


def infer_categories_from_text(*texts: str) -> list[str]:
    blob = " ".join(t for t in texts if t).lower()
    found = []
    for pat, cat in CATEGORY_PATTERNS:
        if re.search(pat, blob, re.I) and cat not in found:
            found.append(cat)
    return found[:4]


def simplify_for_skill(text: str, skill_level: str) -> str:
    if skill_level != "beginner":
        return text
    # keep first sentence-ish
    parts = re.split(r"(?<=[.!?])\s+", text.strip())
    return parts[0] if parts else text


def build_strategy_drill(rec: StrategyRecord, *, platform: str | None, control_scheme: str | None) -> dict[str, Any]:
    return {
        "drillName": f"{rec.strategy_name} Reps",
        "gameTitle": rec.game_title,
        "platform": platform,
        "controlScheme": control_scheme,
        "position": rec.position,
        "objective": rec.objective,
        "setup": rec.setup or f"Practice {rec.zone} situations for {rec.category}",
        "strategy": rec.strategy_name,
        "requiredMechanics": rec.required_mechanics[:4],
        "controls": [],  # filled by control layer when verified
        "repetitions": 8 if rec.skill_level == "beginner" else 12,
        "successCriteria": (rec.success_indicators[0] if rec.success_indicators else "Clean execution without turnover"),
        "commonErrors": rec.common_mistakes[:3] or ["Rushing the read", "Leaving responsibility"],
        "progression": "Add passive pressure after 5 clean reps",
        "classification": rec.classification,
    }


def attach_strategy_to_report(
    report: dict[str, Any],
    *,
    reg: StrategyRegistry,
    game_title: str,
    player_context: dict[str, Any] | None,
    gameplay_context: dict[str, Any] | None = None,
    identity: dict[str, Any] | None = None,
    control_registry: Any | None = None,
    control_enabled: bool = False,
    enabled: bool | None = None,
    skill_level: str | None = None,
) -> dict[str, Any]:
    enabled = STRATEGY_GUIDANCE_ENABLED if enabled is None else enabled
    out = dict(report)
    pc = dict(player_context or {})
    gc = gameplay_context or {}
    position = (
        (identity or {}).get("position")
        or pc.get("position")
        or gc.get("position")
        or "UNKNOWN"
    )
    if isinstance(position, str):
        position = position.upper()
        if position in ("CENTER",):
            position = "C"
    game_mode = (pc.get("gameMode") or gc.get("gameMode") or "eashl")
    if isinstance(game_mode, str):
        game_mode = game_mode.lower()
    game_state = pc.get("gameState") or gc.get("gameState") or "any"
    skill = skill_level or pc.get("skillLevel") or gc.get("skillLevel") or "all"
    platform = pc.get("platform")
    scheme = pc.get("controlScheme") or pc.get("control_scheme")

    out["strategyContext"] = {
        "gameTitle": game_title,
        "guidanceEnabled": bool(enabled),
        "position": position,
        "gameMode": game_mode,
    }

    if not enabled:
        return out

    # Gather text from moments for category inference
    moments = out.get("coachingMoments") if isinstance(out.get("coachingMoments"), list) else []
    texts = []
    for m in moments:
        if isinstance(m, dict):
            texts.extend(
                [
                    str(m.get("title") or ""),
                    str(m.get("teaser") or ""),
                    str(m.get("fullBreakdown") or ""),
                    str(m.get("observedAction") or ""),
                ]
            )
    # explicit strategy hints
    if gc.get("observedSystem"):
        texts.append(str(gc["observedSystem"]))
    cats = infer_categories_from_text(*texts)
    if gc.get("strategyCategory"):
        cats = [str(gc["strategyCategory"])] + cats

    # zone from context
    zone = gc.get("zone") or pc.get("zone")
    if zone:
        zone = str(zone).lower().replace(" ", "_")

    if not cats and not moments:
        # no visible strategy signal — omit unsupported strategyAnalysis claims
        return out

    primary_cat = cats[0] if cats else None
    matches = []
    if primary_cat:
        matches = reg.query(
            game_title=game_title,
            category=primary_cat,
            position=position if position != "UNKNOWN" else None,
            zone=zone,
            game_mode=game_mode,
            game_state=str(game_state),
            production_only=True,
        )
    if not matches and cats:
        for c in cats[1:]:
            matches = reg.query(
                game_title=game_title,
                category=c,
                position=position if position != "UNKNOWN" else None,
                production_only=True,
            )
            if matches:
                primary_cat = c
                break

    if not matches:
        # still allow faceoff integration section pointer without inventing system
        if "faceoff_strategy" in cats or (out.get("faceoffs") or {}).get("applicable"):
            out["strategyAnalysis"] = {
                "gameTitle": game_title,
                "gameMode": game_mode,
                "position": position,
                "observedSystem": "faceoff_sequence",
                "playerResponsibility": "See faceoffs section for draw + post-draw plan",
                "executionGrade": None,
                "strengths": [],
                "improvements": [],
                "recommendedStrategy": None,
                "knownCounters": [],
                "executionControls": [],
                "practiceDrill": None,
                "evidenceConfidence": 0.5,
                "note": "Faceoff details in report.faceoffs; no full team system claimed",
            }
        return out

    rec = matches[0]
    # execution grade heuristic from moment confidence / identity
    grade = 70
    if moments:
        confs = [float(m.get("attributionConfidence") or m.get("confidence") or 0.7) for m in moments if isinstance(m, dict)]
        if confs:
            grade = int(round(100 * (sum(confs) / len(confs)) * 0.85))

    adj = simplify_for_skill(
        rec.player_responsibility[0] if rec.player_responsibility else rec.objective,
        skill if isinstance(skill, str) else "all",
    )
    strengths = []
    improvements = [
        {
            "observation": texts[0][:160] if texts else "Gameplay pattern observed",
            "strategyCategory": rec.category,
            "position": position,
            "playerResponsibility": adj,
            "recommendedAdjustment": simplify_for_skill(
                "; ".join(rec.player_responsibility[:2]) or rec.objective,
                skill if isinstance(skill, str) else "all",
            ),
            "requiredMechanics": rec.required_mechanics[:4],
            "whyItMatters": rec.objective,
            "classification": rec.classification,
            "confidence": _conf_num(rec.confidence),
            "gameTitle": game_title,
            "platform": platform,
            "controlScheme": scheme,
        }
    ]
    if skill == "beginner":
        improvements = improvements[:1]
        improvements[0]["recommendedAdjustment"] = simplify_for_skill(
            improvements[0]["recommendedAdjustment"], "beginner"
        )
    else:
        # advanced: include counters + reads
        improvements[0]["requiredReads"] = rec.required_reads[:3]
        improvements[0]["counters"] = rec.counters[:3]

    drill = build_strategy_drill(rec, platform=platform, control_scheme=scheme)
    controls_out = []
    if control_registry is not None and control_enabled and rec.required_mechanics:
        try:
            from controls.registry import lookup_execution

            for mech in rec.required_mechanics[:2]:
                ex = lookup_execution(
                    control_registry,
                    mechanic=mech if mech not in ("controlled_skating", "quick_pass") else _map_mech(mech),
                    player_context=pc,
                    game_title=game_title,
                    enabled=control_enabled,
                )
                controls_out.append(ex.to_dict())
                if ex.available and not drill["controls"]:
                    drill["controls"] = ex.inputs
        except Exception:
            pass

    # annotate moments lightly
    new_moments = []
    for m in moments:
        if not isinstance(m, dict):
            continue
        mm = dict(m)
        if "strategyCategory" not in mm and primary_cat:
            mm["strategyCategory"] = primary_cat
        if "playerResponsibility" not in mm and rec.player_responsibility:
            mm["playerResponsibility"] = simplify_for_skill(rec.player_responsibility[0], skill if isinstance(skill, str) else "all")
        new_moments.append(mm)
    if new_moments:
        out["coachingMoments"] = new_moments

    out["strategyAnalysis"] = {
        "gameTitle": game_title,
        "gameMode": game_mode,
        "position": position,
        "observedSystem": rec.strategy_name,
        "strategyId": rec.strategy_id,
        "classification": rec.classification,
        "playerResponsibility": adj,
        "executionGrade": grade,
        "strengths": strengths,
        "improvements": improvements,
        "recommendedStrategy": rec.to_dict(),
        "knownCounters": rec.counters[:5],
        "executionControls": controls_out,
        "practiceDrill": drill,
        "evidenceConfidence": _conf_num(rec.confidence),
    }
    return out


def _map_mech(m: str) -> str:
    return {
        "controlled_skating": "hustle",
        "quick_pass": "pass",
        "puck_protection": "protect_puck",
        "vision_control": "vision_control",
        "call_for_pass": "call_for_pass",
    }.get(m, m)


def _conf_num(c: str) -> float:
    return {
        "official": 0.95,
        "high": 0.88,
        "medium": 0.7,
        "low": 0.45,
        "unverified": 0.3,
        "conflicting": 0.2,
    }.get(c, 0.5)


def _norm_title(t: str) -> str:
    return " ".join(str(t or "").lower().replace("ea sports", "").split())


def _slug_title(t: str) -> str:
    return re.sub(r"[^a-z0-9]+", "", _norm_title(t))
