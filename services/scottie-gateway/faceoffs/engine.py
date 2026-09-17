"""Faceoff detection, evaluation, drills, and report section."""
from __future__ import annotations

import re
from dataclasses import asdict, dataclass, field
from typing import Any

from . import FACEOFF_MECHANICS, FACEOFF_ZONES


@dataclass
class FaceoffEvent:
    event_id: str
    timestamp: float
    zone: str  # offensive|defensive|neutral|power_play|penalty_kill|unknown
    result: str  # win|loss|tie|unknown
    win_direction: str | None = None  # forward|backhand|strong|weak|unknown
    timing_quality: str | None = None  # early|on_time|late|unknown
    stick_position_note: str | None = None
    counter_used: str | None = None
    tie_up: bool = False
    controlled_player_is_center: bool | None = None
    handedness_user: str | None = None  # L|R
    handedness_opp: str | None = None
    possession_quality: str | None = None  # clean|contested|lost_immediately|unknown
    post_draw_play: str | None = None
    support_ok: bool | None = None
    confidence: float = 0.5
    evidence: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class FaceoffReportSection:
    applicable: bool
    draws_analyzed: int = 0
    wins: int = 0
    losses: int = 0
    ties: int = 0
    win_pct: float | None = None
    execution_quality: float | None = None  # 0-100
    timing_consistency: float | None = None
    strategy_selection_score: float | None = None
    counter_effectiveness: float | None = None
    possession_created_score: float | None = None
    scoring_chances_note: str | None = None
    defensive_recoveries_note: str | None = None
    improvement_priorities: list[str] = field(default_factory=list)
    events: list[dict[str, Any]] = field(default_factory=list)
    recommendations: list[dict[str, Any]] = field(default_factory=list)
    drills: list[dict[str, Any]] = field(default_factory=list)
    game_title: str = "NHL 26"
    legacy_knowledge_excluded: bool = True

    def to_dict(self) -> dict[str, Any] | None:
        if not self.applicable:
            return None
        return {
            "applicable": True,
            "drawsAnalyzed": self.draws_analyzed,
            "wins": self.wins,
            "losses": self.losses,
            "ties": self.ties,
            "winPct": self.win_pct,
            "executionQuality": self.execution_quality,
            "timingConsistency": self.timing_consistency,
            "strategySelectionScore": self.strategy_selection_score,
            "counterEffectiveness": self.counter_effectiveness,
            "possessionCreatedScore": self.possession_created_score,
            "scoringChancesNote": self.scoring_chances_note,
            "defensiveRecoveriesNote": self.defensive_recoveries_note,
            "improvementPriorities": self.improvement_priorities,
            "events": self.events,
            "recommendations": self.recommendations,
            "drills": self.drills,
            "gameTitle": self.game_title,
            "legacyKnowledgeExcluded": self.legacy_knowledge_excluded,
        }


def load_faceoff_events(
    gameplay_context: dict[str, Any] | None,
    metadata: dict[str, Any] | None,
    frame_metas: list[dict[str, Any]] | None = None,
) -> list[FaceoffEvent]:
    """Load injected faceoff events (tests / upstream vision). Never invent from nothing."""
    bag = {}
    for src in (gameplay_context or {}, metadata or {}):
        if isinstance(src, dict):
            bag.update(src)
    raw = bag.get("faceoffEvents") or bag.get("faceoffs") or []
    events: list[FaceoffEvent] = []
    if isinstance(raw, list):
        for i, e in enumerate(raw):
            if not isinstance(e, dict):
                continue
            zone = str(e.get("zone") or "unknown").lower().replace(" ", "_").replace("-", "_")
            if zone in ("oz", "offensive_zone"):
                zone = "offensive"
            if zone in ("dz", "defensive_zone"):
                zone = "defensive"
            if zone in ("nz", "neutral_zone"):
                zone = "neutral"
            if zone in ("pp", "powerplay"):
                zone = "power_play"
            if zone in ("pk", "penaltykill", "shorthand"):
                zone = "penalty_kill"
            if zone not in FACEOFF_ZONES:
                zone = "unknown"
            result = str(e.get("result") or "unknown").lower()
            if result not in ("win", "loss", "tie", "unknown"):
                result = "unknown"
            ts = float(e.get("timestamp") or e.get("timestampSeconds") or 0.0)
            events.append(
                FaceoffEvent(
                    event_id=str(e.get("id") or f"fo-{i+1}"),
                    timestamp=ts,
                    zone=zone,
                    result=result,
                    win_direction=_opt_str(e.get("winDirection") or e.get("win_direction")),
                    timing_quality=_opt_str(e.get("timingQuality") or e.get("timing_quality")),
                    stick_position_note=_opt_str(e.get("stickPosition") or e.get("stick_position_note")),
                    counter_used=_opt_str(e.get("counter") or e.get("counter_used")),
                    tie_up=bool(e.get("tieUp") or e.get("tie_up")),
                    controlled_player_is_center=e.get("controlledPlayerIsCenter", e.get("isCenter")),
                    handedness_user=_hand(e.get("handednessUser") or e.get("userHandedness")),
                    handedness_opp=_hand(e.get("handednessOpp") or e.get("oppHandedness")),
                    possession_quality=_opt_str(e.get("possessionQuality") or e.get("possession_quality")),
                    post_draw_play=_opt_str(e.get("postDrawPlay") or e.get("post_draw_play")),
                    support_ok=e.get("supportOk", e.get("support_ok")),
                    confidence=float(e.get("confidence") or 0.7),
                    evidence=list(e.get("evidence") or [])[:6],
                )
            )

    # Weak textual signal only if explicitly tagged in context
    if not events and bag.get("containsFaceoffs") is True:
        # placeholder single unknown event — still better than generic spam
        events.append(
            FaceoffEvent(
                event_id="fo-context",
                timestamp=0.0,
                zone="unknown",
                result="unknown",
                confidence=0.4,
                evidence=["context flag containsFaceoffs=true without structured events"],
            )
        )
    return events


def evaluate_faceoffs(
    events: list[FaceoffEvent],
    *,
    game_title: str = "NHL 26",
    player_role: str | None = None,
    control_lookup: Any | None = None,
    player_context: dict[str, Any] | None = None,
    control_enabled: bool = False,
) -> FaceoffReportSection:
    """Build faceoff section. Returns applicable=False if no events."""
    if not events:
        return FaceoffReportSection(applicable=False, game_title=game_title)

    wins = sum(1 for e in events if e.result == "win")
    losses = sum(1 for e in events if e.result == "loss")
    ties = sum(1 for e in events if e.result == "tie")
    decided = wins + losses
    win_pct = round(100.0 * wins / decided, 1) if decided else None

    # Execution quality composite (not just W/L)
    scores = [_event_quality(e) for e in events]
    execution = round(sum(scores) / len(scores), 1) if scores else None

    timing_vals = []
    for e in events:
        if e.timing_quality == "on_time":
            timing_vals.append(90)
        elif e.timing_quality == "early":
            timing_vals.append(55)
        elif e.timing_quality == "late":
            timing_vals.append(45)
        elif e.timing_quality:
            timing_vals.append(50)
    timing_consistency = round(sum(timing_vals) / len(timing_vals), 1) if timing_vals else None

    strategy_scores = []
    for e in events:
        strategy_scores.append(_strategy_fit(e))
    strategy_selection = round(sum(strategy_scores) / len(strategy_scores), 1) if strategy_scores else None

    counter_scores = []
    for e in events:
        if e.counter_used:
            counter_scores.append(80 if e.result == "win" else 45)
        elif e.result != "unknown":
            counter_scores.append(60)
    counter_eff = round(sum(counter_scores) / len(counter_scores), 1) if counter_scores else None

    poss_scores = []
    for e in events:
        pq = (e.possession_quality or "").lower()
        if pq == "clean":
            poss_scores.append(90)
        elif pq == "contested":
            poss_scores.append(65)
        elif pq == "lost_immediately":
            poss_scores.append(30)
    poss = round(sum(poss_scores) / len(poss_scores), 1) if poss_scores else None

    priorities = _improvement_priorities(events, timing_consistency, poss, strategy_selection)
    recs = _recommendations(events, game_title=game_title, player_role=player_role)
    # attach controls if lookup provided
    if control_lookup is not None and player_context is not None:
        recs = _attach_controls(
            recs,
            control_lookup=control_lookup,
            player_context=player_context,
            game_title=game_title,
            enabled=control_enabled,
        )
    drills = generate_faceoff_drills(events, player_context=player_context, control_enabled=control_enabled)

    return FaceoffReportSection(
        applicable=True,
        draws_analyzed=len(events),
        wins=wins,
        losses=losses,
        ties=ties,
        win_pct=win_pct,
        execution_quality=execution,
        timing_consistency=timing_consistency,
        strategy_selection_score=strategy_selection,
        counter_effectiveness=counter_eff,
        possession_created_score=poss,
        scoring_chances_note=_scoring_note(events),
        defensive_recoveries_note=_recovery_note(events),
        improvement_priorities=priorities,
        events=[e.to_dict() for e in events],
        recommendations=recs,
        drills=drills,
        game_title=game_title,
        legacy_knowledge_excluded=True,
    )


def generate_faceoff_drills(
    events: list[FaceoffEvent],
    *,
    player_context: dict[str, Any] | None = None,
    control_enabled: bool = False,
    max_drills: int = 3,
) -> list[dict[str, Any]]:
    pc = player_context or {}
    platform = pc.get("platform")
    scheme = pc.get("controlScheme") or pc.get("control_scheme")
    drills: list[dict[str, Any]] = []

    needs_timing = any(e.timing_quality in ("early", "late") for e in events) or not events
    needs_tie = any(e.tie_up for e in events)
    zones = {e.zone for e in events}

    if needs_timing or True:
        drills.append(
            {
                "drillName": "Faceoff Reaction Timing",
                "objective": "Synchronize stick-down with the puck drop window.",
                "setup": "Practice faceoff dots; vary drop cadence if available.",
                "repetitions": 15,
                "successCriteria": "On-time stick engagement on ≥80% of reps without early penalty animation.",
                "progression": "Add opponent pressure stance after 10 clean reps.",
                "commonErrors": ["Dropping early", "Watching puck instead of stick"],
                "requiredMechanics": ["faceoff_timing", "faceoff_draw"],
                "platform": platform,
                "controlScheme": scheme,
                "controls": [],
                "zoneFocus": "all",
            }
        )
    if needs_tie:
        drills.append(
            {
                "drillName": "Tie-Up Control",
                "objective": "Secure a controlled tie-up then exit to a planned support lane.",
                "setup": "Dot work with a partner; call exit side before drop.",
                "repetitions": 12,
                "successCriteria": "Stable tie-up ≥0.5s then clean exit to called side.",
                "progression": "Add weak-side winger target.",
                "commonErrors": ["Stalling with no exit", "Losing body position"],
                "requiredMechanics": ["faceoff_tie_up", "faceoff_post_win_possession"],
                "platform": platform,
                "controlScheme": scheme,
                "controls": [],
                "zoneFocus": "all",
            }
        )
    if "offensive" in zones or not events:
        drills.append(
            {
                "drillName": "OZ Directional Win → Set",
                "objective": "Win strong/weak side intentionally and hit the first set option.",
                "setup": "OZ dots; designate bumper/flank target before each draw.",
                "repetitions": 10,
                "successCriteria": "Possession to target within two touches after win.",
                "progression": "Add PK pressure.",
                "commonErrors": ["Random win direction", "No winger support"],
                "requiredMechanics": ["faceoff_win_strong_side", "faceoff_oz_set"],
                "platform": platform,
                "controlScheme": scheme,
                "controls": [],
                "zoneFocus": "offensive",
            }
        )
    if "defensive" in zones:
        drills.append(
            {
                "drillName": "DZ Escape After Win",
                "objective": "Win safely to support and exit without a turnover.",
                "setup": "DZ dots; D calls exit side.",
                "repetitions": 10,
                "successCriteria": "Controlled exit or ice-out under pressure.",
                "progression": "Faster opponent center.",
                "commonErrors": ["Winning into traffic", "Panic rim"],
                "requiredMechanics": ["faceoff_dz_escape", "faceoff_d_support"],
                "platform": platform,
                "controlScheme": scheme,
                "controls": [],
                "zoneFocus": "defensive",
            }
        )
    if "power_play" in zones:
        drills.append(
            {
                "drillName": "PP Faceoff Set",
                "objective": "Win to predetermined PP structure.",
                "setup": "OZ PP dots; call set name.",
                "repetitions": 8,
                "successCriteria": "First touch to set player without turnover.",
                "progression": "Add aggressive PK.",
                "commonErrors": ["Improvised win side"],
                "requiredMechanics": ["faceoff_pp_setup"],
                "platform": platform,
                "controlScheme": scheme,
                "controls": [],
                "zoneFocus": "power_play",
            }
        )
    if "penalty_kill" in zones:
        drills.append(
            {
                "drillName": "PK Faceoff Deny",
                "objective": "Disrupt clean PP wins and clear.",
                "setup": "DZ PK dots.",
                "repetitions": 8,
                "successCriteria": "No direct slot win against; clear or ice when won.",
                "progression": "Handedness matchup swaps.",
                "commonErrors": ["Chasing after loss"],
                "requiredMechanics": ["faceoff_pk_pressure"],
                "platform": platform,
                "controlScheme": scheme,
                "controls": [],
                "zoneFocus": "penalty_kill",
            }
        )
    if "neutral" in zones:
        drills.append(
            {
                "drillName": "NZ Win → Transition",
                "objective": "Win NZ draw into controlled transition.",
                "setup": "Center ice dots.",
                "repetitions": 10,
                "successCriteria": "First pass completes under light pressure.",
                "progression": "Add backpressure.",
                "commonErrors": ["Standing still after win"],
                "requiredMechanics": ["faceoff_nz_transition"],
                "platform": platform,
                "controlScheme": scheme,
                "controls": [],
                "zoneFocus": "neutral",
            }
        )

    # handedness-specific note drill
    if any(e.handedness_user and e.handedness_opp for e in events):
        drills.append(
            {
                "drillName": "Handedness Matchup Reps",
                "objective": "Practice preferred counters vs opposite-hand centers.",
                "setup": "Alternate L/R opponents.",
                "repetitions": 12,
                "successCriteria": "Stable grip and planned counter each rep.",
                "progression": "Faster drops.",
                "commonErrors": ["Ignoring matchup"],
                "requiredMechanics": ["faceoff_counter", "faceoff_grip_change"],
                "platform": platform,
                "controlScheme": scheme,
                "controls": [],
                "zoneFocus": "all",
            }
        )

    # de-dupe by name, cap
    seen = set()
    out = []
    for d in drills:
        if d["drillName"] in seen:
            continue
        seen.add(d["drillName"])
        out.append(d)
        if len(out) >= max_drills:
            break
    return out


def attach_faceoff_section(
    report: dict[str, Any],
    *,
    gameplay_context: dict[str, Any] | None,
    metadata: dict[str, Any] | None,
    frame_metas: list[dict[str, Any]] | None = None,
    game_title: str = "NHL 26",
    player_context: dict[str, Any] | None = None,
    control_registry: Any | None = None,
    control_enabled: bool = False,
) -> dict[str, Any]:
    """Add faceoff section when events exist; omit otherwise (no generic filler)."""
    out = dict(report)
    events = load_faceoff_events(gameplay_context, metadata, frame_metas)
    if not events:
        # explicitly do not add empty generic faceoff advice
        out.pop("faceoffs", None)
        return out

    role = None
    pc = player_context or {}
    if pc.get("position") in ("C", "CENTER"):
        role = "center"
    section = evaluate_faceoffs(
        events,
        game_title=game_title,
        player_role=role,
        control_lookup=control_registry,
        player_context=player_context,
        control_enabled=control_enabled,
    )
    d = section.to_dict()
    if d:
        out["faceoffs"] = d
    return out


def _opt_str(v: Any) -> str | None:
    if v is None or v == "":
        return None
    return str(v)


def _hand(v: Any) -> str | None:
    if not v:
        return None
    s = str(v).strip().upper()
    if s in ("L", "LEFT", "LH"):
        return "L"
    if s in ("R", "RIGHT", "RH"):
        return "R"
    return None


def _event_quality(e: FaceoffEvent) -> float:
    score = 50.0
    if e.result == "win":
        score += 15
    elif e.result == "loss":
        score -= 10
    if e.timing_quality == "on_time":
        score += 15
    elif e.timing_quality in ("early", "late"):
        score -= 10
    if e.possession_quality == "clean":
        score += 15
    elif e.possession_quality == "lost_immediately":
        score -= 15
    if e.support_ok is True:
        score += 5
    elif e.support_ok is False:
        score -= 5
    if e.post_draw_play:
        score += 5
    if e.tie_up and e.result == "win":
        score += 5
    return max(0.0, min(100.0, score))


def _strategy_fit(e: FaceoffEvent) -> float:
    # Did strategy match zone?
    score = 60.0
    if e.zone == "offensive" and e.win_direction in ("strong", "weak", "forward"):
        score += 15
    if e.zone == "defensive" and e.result == "win" and e.possession_quality != "lost_immediately":
        score += 15
    if e.zone == "power_play" and e.result == "win":
        score += 10
    if e.zone == "penalty_kill" and e.result == "loss" and e.support_ok:
        score += 10  # structured recover
    if e.counter_used:
        score += 5
    if e.result == "loss" and e.possession_quality == "lost_immediately" and e.zone == "defensive":
        score -= 15
    return max(0.0, min(100.0, score))


def _improvement_priorities(
    events: list[FaceoffEvent],
    timing: float | None,
    poss: float | None,
    strategy: float | None,
) -> list[str]:
    pri: list[str] = []
    if timing is not None and timing < 70:
        pri.append("Improve stick-down timing consistency")
    if poss is not None and poss < 65:
        pri.append("Convert draws into cleaner first possession")
    if strategy is not None and strategy < 65:
        pri.append("Match win direction and setup to zone/special teams")
    if any(e.support_ok is False for e in events):
        pri.append("Align winger/D support with intended win side")
    if any(e.result == "loss" and not e.post_draw_play for e in events):
        pri.append("Define post-loss recovery routes before the drop")
    if not pri:
        pri.append("Maintain timing and add matchup-specific counters")
    return pri[:5]


def _recommendations(
    events: list[FaceoffEvent],
    *,
    game_title: str,
    player_role: str | None,
) -> list[dict[str, Any]]:
    recs = []
    # Timing
    if any(e.timing_quality in ("early", "late") for e in events):
        recs.append(
            _rec(
                "rec_fo_timing",
                "Faceoff timing was early or late on one or more draws.",
                "Settle grip earlier and time stick engagement with the drop window.",
                when_to_use="Every draw — especially after a prior early/late miss.",
                why="Timing errors concede free possession regardless of grip choice.",
                mechanic="faceoff_timing",
                zone="all",
                mistakes=["Dropping early", "Reacting only after puck moves"],
                alternatives=["Slightly delayed counter if opponent telegraphs early"],
                confidence=0.75,
                evidence=[e.event_id for e in events if e.timing_quality in ("early", "late")],
            )
        )
    # Tie-up
    if any(e.tie_up for e in events):
        recs.append(
            _rec(
                "rec_fo_tieup",
                "Tie-up sequences appeared in the clip.",
                "Use tie-ups deliberately, then exit to a pre-called support side.",
                when_to_use="When a clean directional win is low percentage.",
                why="Unplanned stalls bleed structure; planned tie-ups create second-man wins.",
                mechanic="faceoff_tie_up",
                zone="all",
                mistakes=["Stalling with no exit plan"],
                alternatives=["Quick reverse win if opponent leans into tie-up"],
                confidence=0.7,
                evidence=[e.event_id for e in events if e.tie_up],
            )
        )
    # Directional
    if any(e.win_direction for e in events):
        recs.append(
            _rec(
                "rec_fo_direction",
                "Directional outcomes were observed — ensure direction matches the set.",
                "Call win side with wingers before engaging; reinforce strong/weak patterns by zone.",
                when_to_use="OZ sets and DZ escapes especially.",
                why="Winning the 'wrong' side kills designed plays.",
                mechanic="faceoff_win_strong_side",
                zone="all",
                mistakes=["Randomizing win direction"],
                alternatives=["Weak-side soft win if strong side is overloaded"],
                confidence=0.72,
                evidence=[e.event_id for e in events if e.win_direction],
            )
        )
    # Post draw
    if any(e.result == "win" and (e.possession_quality == "lost_immediately" or not e.post_draw_play) for e in events):
        recs.append(
            _rec(
                "rec_fo_post",
                "Post-faceoff execution did not fully capitalize on the draw.",
                "Pre-select first touch: pass target or protect-and-move before the drop.",
                when_to_use="Immediately after any clean or contested win.",
                why="Wins without a plan become 50/50s.",
                mechanic="faceoff_post_win_possession",
                zone="all",
                mistakes=["Standing still after winning the puck"],
                alternatives=["Chip to space if first option is covered"],
                confidence=0.74,
                evidence=[e.event_id for e in events if e.result == "win"],
            )
        )
    # Zone-specific
    if any(e.zone == "offensive" for e in events):
        recs.append(
            _rec(
                "rec_fo_oz",
                "Offensive-zone draw(s) present.",
                "Prioritize win direction into the planned OZ set; wingers load the called side.",
                when_to_use="All OZ faceoffs with a set play.",
                why="OZ draws are high-leverage possession events.",
                mechanic="faceoff_oz_set",
                zone="offensive",
                mistakes=["Wingers cheating before the drop"],
                alternatives=["Net-front crash on loss"],
                confidence=0.7,
                evidence=[e.event_id for e in events if e.zone == "offensive"],
            )
        )
    if any(e.zone == "defensive" for e in events):
        recs.append(
            _rec(
                "rec_fo_dz",
                "Defensive-zone draw(s) present.",
                "Prefer safe win to support; on loss, lock lanes before chasing the puck.",
                when_to_use="All DZ faceoffs under pressure.",
                why="DZ losses become slot chances if recovery is late.",
                mechanic="faceoff_dz_escape",
                zone="defensive",
                mistakes=["Winning into the slot under pressure"],
                alternatives=["Tie-up to allow D reset"],
                confidence=0.7,
                evidence=[e.event_id for e in events if e.zone == "defensive"],
            )
        )
    if any(e.zone == "neutral" for e in events):
        recs.append(
            _rec(
                "rec_fo_nz",
                "Neutral-zone draw(s) present.",
                "Win into a controlled transition pass; on loss, gap up through the NZ.",
                when_to_use="NZ draws with numbers.",
                why="NZ wins start controlled entries; losses become rush defense.",
                mechanic="faceoff_nz_transition",
                zone="neutral",
                mistakes=["Static after win"],
                alternatives=["Soft dump if pass is covered"],
                confidence=0.68,
                evidence=[e.event_id for e in events if e.zone == "neutral"],
            )
        )
    if any(e.zone == "power_play" for e in events):
        recs.append(
            _rec(
                "rec_fo_pp",
                "Power-play faceoff(s) present.",
                "Win to the called PP structure only; do not freestyle the first touch.",
                when_to_use="OZ PP dots.",
                why="PP structure depends on predictable first possession.",
                mechanic="faceoff_pp_setup",
                zone="power_play",
                mistakes=["Winning away from bumper/flank"],
                alternatives=["Timeout reset if matchup is cold"],
                confidence=0.7,
                evidence=[e.event_id for e in events if e.zone == "power_play"],
            )
        )
    if any(e.zone == "penalty_kill" for e in events):
        recs.append(
            _rec(
                "rec_fo_pk",
                "Penalty-kill faceoff(s) present.",
                "Disrupt clean PP wins; clear or ice when you win; collapse lanes on loss.",
                when_to_use="All PK draws.",
                why="PK faceoffs swing shot quality against.",
                mechanic="faceoff_pk_pressure",
                zone="penalty_kill",
                mistakes=["Chasing the puck after a loss"],
                alternatives=["Aggressive stick through hands if legal"],
                confidence=0.7,
                evidence=[e.event_id for e in events if e.zone == "penalty_kill"],
            )
        )
    if any(e.handedness_user and e.handedness_opp for e in events):
        recs.append(
            _rec(
                "rec_fo_hand",
                "Handedness matchup was observable.",
                "Select grip/counter family for L-vs-R before the drop; practice both sides.",
                when_to_use="Any known opposite-hand opponent.",
                why="Handedness changes stick angles and strong-side percentages.",
                mechanic="faceoff_counter",
                zone="all",
                mistakes=["Using the same move vs both hands"],
                alternatives=["Grip change if first attempt fails"],
                confidence=0.65,
                evidence=[e.event_id for e in events if e.handedness_user],
            )
        )
    # Center-specific default if no other recs
    if not recs and player_role == "center":
        recs.append(
            _rec(
                "rec_fo_default",
                "Faceoff(s) involved the controlled center.",
                "Pre-draw checklist: grip, timing, win side, first play.",
                when_to_use="Every draw.",
                why="Centers drive possession starts.",
                mechanic="faceoff_draw",
                zone="all",
                mistakes=["No pre-draw plan"],
                alternatives=[],
                confidence=0.6,
                evidence=[e.event_id for e in events],
            )
        )
    # tag game title / no legacy
    for r in recs:
        r["gameTitle"] = game_title
        r["legacyStrategy"] = False
    return recs[:8]


def _rec(rid: str, observation: str, adjustment: str, **kw: Any) -> dict[str, Any]:
    return {
        "recommendationId": rid,
        "observation": observation,
        "adjustment": adjustment,
        "whyItMatters": kw.get("why"),
        "whenToUse": kw.get("when_to_use"),
        "mechanic": kw.get("mechanic"),
        "zone": kw.get("zone"),
        "commonMistakes": kw.get("mistakes") or [],
        "alternativeCounters": kw.get("alternatives") or [],
        "confidence": kw.get("confidence", 0.7),
        "evidenceEventIds": kw.get("evidence") or [],
        "execution": None,  # filled if controls available
        "xboxControls": None,
        "playstationControls": None,
    }


def _attach_controls(
    recs: list[dict[str, Any]],
    *,
    control_lookup: Any,
    player_context: dict[str, Any],
    game_title: str,
    enabled: bool,
) -> list[dict[str, Any]]:
    try:
        from controls.registry import lookup_execution
    except Exception:
        return recs
    out = []
    for r in recs:
        rr = dict(r)
        mech = rr.get("mechanic") or "faceoff_draw"
        ex = lookup_execution(
            control_lookup,
            mechanic=mech,
            player_context=player_context,
            game_title=game_title,
            enabled=enabled,
        )
        rr["execution"] = ex.to_dict()
        # dual platform reference when user platform known — still separate, not mixed
        if enabled:
            for plat, key in (("xbox_series", "xboxControls"), ("playstation_5", "playstationControls")):
                pc = {**player_context, "platform": plat}
                # keep user's scheme
                ex2 = lookup_execution(
                    control_lookup,
                    mechanic=mech,
                    player_context=pc,
                    game_title=game_title,
                    enabled=enabled,
                )
                rr[key] = ex2.to_dict() if ex2.available else {"executionAvailable": False, "reason": ex2.reason}
        out.append(rr)
    return out


def _scoring_note(events: list[FaceoffEvent]) -> str:
    oz_wins = [e for e in events if e.zone == "offensive" and e.result == "win"]
    if not oz_wins:
        return "No OZ wins in sample — scoring-chance link not established."
    clean = sum(1 for e in oz_wins if e.possession_quality == "clean")
    return f"{len(oz_wins)} OZ win(s); {clean} with clean possession — chances depend on post-draw execution."


def _recovery_note(events: list[FaceoffEvent]) -> str:
    losses = [e for e in events if e.result == "loss"]
    if not losses:
        return "No losses in sample."
    good = sum(1 for e in losses if e.support_ok or e.post_draw_play)
    return f"{good}/{len(losses)} losses showed structured recovery/support."


# Research hook keywords
FACEOFF_SIGNAL = re.compile(
    r"\b(face[- ]?off|draw specialist|stick grip|faceoff timing|faceoff counter)\b",
    re.I,
)


def scan_docs_for_faceoff_signals(docs: list[Any]) -> dict[str, Any]:
    hits = []
    for d in docs or []:
        text = d.safe_text() if hasattr(d, "safe_text") else str(getattr(d, "snippet", d))
        if FACEOFF_SIGNAL.search(text or ""):
            hits.append({"url": getattr(d, "url", ""), "excerpt": (text or "")[:160]})
    return {
        "faceoff_signal": bool(hits),
        "hits": hits[:5],
        "deep_research_recommended": bool(hits),
    }
