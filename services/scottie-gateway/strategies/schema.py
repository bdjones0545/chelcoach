"""Strategy knowledge schema + validation."""
from __future__ import annotations

from dataclasses import asdict, dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any

from . import CATEGORIES, CLASS_LABELS, CONFIDENCE, FRESHNESS_DAYS, POSITIONS, STATUSES


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def parse_iso(s: str | None) -> datetime | None:
    if not s:
        return None
    try:
        return datetime.fromisoformat(str(s).replace("Z", "+00:00"))
    except ValueError:
        return None


@dataclass
class StrategyRecord:
    strategy_id: str
    game_title: str
    game_version: str
    game_mode: str
    position: str
    zone: str
    category: str
    strategy_name: str
    objective: str
    player_responsibility: list[str]
    required_mechanics: list[str]
    classification: str  # fundamental|current_meta|...
    confidence: str
    status: str
    verified_at: str = ""
    patch_version: str = ""
    game_state: str = "any"  # leading|trailing|tied|ot|empty_net|pp|pk|any
    setup: str = ""
    teammate_responsibilities: list[str] = field(default_factory=list)
    opponent_behavior: str = ""
    required_reads: list[str] = field(default_factory=list)
    success_indicators: list[str] = field(default_factory=list)
    failure_indicators: list[str] = field(default_factory=list)
    common_mistakes: list[str] = field(default_factory=list)
    counters: list[str] = field(default_factory=list)
    counter_adjustments: list[str] = field(default_factory=list)
    evidence_sources: list[str] = field(default_factory=list)
    source_type: str = "internal"  # official|competitive|reddit|creator|internal|fixture
    control_scheme: str = "any"
    skill_level: str = "all"  # beginner|intermediate|advanced|all
    freshness_days: int | None = None
    notes: str = ""

    def to_dict(self) -> dict[str, Any]:
        d = asdict(self)
        # camelCase public
        return {
            "strategyId": self.strategy_id,
            "gameTitle": self.game_title,
            "gameVersion": self.game_version,
            "gameMode": self.game_mode,
            "position": self.position,
            "zone": self.zone,
            "category": self.category,
            "strategyName": self.strategy_name,
            "objective": self.objective,
            "setup": self.setup,
            "playerResponsibility": self.player_responsibility,
            "teammateResponsibilities": self.teammate_responsibilities,
            "opponentBehavior": self.opponent_behavior,
            "requiredReads": self.required_reads,
            "requiredMechanics": self.required_mechanics,
            "successIndicators": self.success_indicators,
            "failureIndicators": self.failure_indicators,
            "commonMistakes": self.common_mistakes,
            "counters": self.counters,
            "counterAdjustments": self.counter_adjustments,
            "evidenceSources": self.evidence_sources,
            "sourceType": self.source_type,
            "classification": self.classification,
            "confidence": self.confidence,
            "status": self.status,
            "verifiedAt": self.verified_at,
            "patchVersion": self.patch_version,
            "gameState": self.game_state,
            "controlScheme": self.control_scheme,
            "skillLevel": self.skill_level,
            "freshnessDays": self.freshness_days,
            "notes": self.notes,
        }

    def is_fresh(self, now: datetime | None = None) -> bool:
        if self.status in ("obsolete", "archived"):
            return False
        if self.classification == "obsolete":
            return False
        days = self.freshness_days
        if days is None:
            if self.source_type == "reddit":
                days = FRESHNESS_DAYS["reddit"]
            elif self.source_type == "creator":
                days = FRESHNESS_DAYS["creator"]
            elif self.source_type == "official":
                days = FRESHNESS_DAYS["official"]
            else:
                days = FRESHNESS_DAYS.get(self.classification, 14)
        if self.classification == "fundamental" and self.status == "approved":
            return True  # principles don't expire daily
        if self.source_type == "official" and self.status == "approved":
            return True
        vt = parse_iso(self.verified_at)
        if not vt:
            return self.status == "approved" and self.classification == "fundamental"
        now = now or utc_now()
        if vt.tzinfo is None:
            vt = vt.replace(tzinfo=timezone.utc)
        return now <= vt + timedelta(days=int(days))

    def production_ready(self) -> bool:
        return (
            self.status == "approved"
            and self.classification not in ("obsolete", "experimental", "legacy")
            and self.confidence not in ("unverified", "conflicting", "low")
            and self.is_fresh()
        )


def validate_strategy_dict(raw: dict[str, Any]) -> tuple[bool, list[str], StrategyRecord | None]:
    errs: list[str] = []
    if not isinstance(raw, dict):
        return False, ["not_object"], None
    cat = str(raw.get("category") or "")
    clas = str(raw.get("classification") or raw.get("class") or "situational")
    conf = str(raw.get("confidence") or "unverified")
    status = str(raw.get("status") or "candidate")
    pos = str(raw.get("position") or "UNKNOWN").upper()
    if pos in ("CENTER",):
        pos = "C"
    if cat not in CATEGORIES:
        errs.append(f"bad_category:{cat}")
    if clas not in CLASS_LABELS:
        errs.append(f"bad_class:{clas}")
    if conf not in CONFIDENCE:
        errs.append(f"bad_confidence:{conf}")
    if status not in STATUSES:
        errs.append(f"bad_status:{status}")
    if pos not in POSITIONS:
        errs.append(f"bad_position:{pos}")
    name = str(raw.get("strategyName") or raw.get("strategy_name") or "").strip()
    if not name:
        errs.append("missing_name")
    # reddit-only cannot be approved without corroboration marker
    src = str(raw.get("sourceType") or raw.get("source_type") or "internal")
    if src == "reddit" and status == "approved" and conf in ("official", "high"):
        # allow only if explicitly multi-corroborated
        if "corroborated" not in str(raw.get("notes") or "").lower():
            errs.append("reddit_cannot_auto_approve_high")
    if errs:
        return False, errs, None

    sid = str(
        raw.get("strategyId")
        or raw.get("strategy_id")
        or f"{_slug(raw.get('gameTitle'))}-{cat}-{_slug(name)}"
    )
    resp = raw.get("playerResponsibility") or raw.get("player_responsibility") or []
    if isinstance(resp, str):
        resp = [resp]
    mechs = raw.get("requiredMechanics") or raw.get("required_mechanics") or []
    if isinstance(mechs, str):
        mechs = [mechs]
    rec = StrategyRecord(
        strategy_id=sid,
        game_title=str(raw.get("gameTitle") or raw.get("game_title") or ""),
        game_version=str(raw.get("gameVersion") or raw.get("game_version") or "current"),
        game_mode=str(raw.get("gameMode") or raw.get("game_mode") or "all").lower(),
        position=pos,
        zone=str(raw.get("zone") or "all"),
        category=cat,
        strategy_name=name,
        objective=str(raw.get("objective") or ""),
        player_responsibility=list(resp),
        required_mechanics=[str(m) for m in mechs],
        classification=clas,
        confidence=conf,
        status=status,
        verified_at=str(raw.get("verifiedAt") or raw.get("verified_at") or ""),
        patch_version=str(raw.get("patchVersion") or ""),
        game_state=str(raw.get("gameState") or raw.get("game_state") or "any"),
        setup=str(raw.get("setup") or ""),
        teammate_responsibilities=list(
            raw.get("teammateResponsibilities") or raw.get("teammate_responsibilities") or []
        ),
        opponent_behavior=str(raw.get("opponentBehavior") or raw.get("opponent_behavior") or ""),
        required_reads=list(raw.get("requiredReads") or raw.get("required_reads") or []),
        success_indicators=list(raw.get("successIndicators") or []),
        failure_indicators=list(raw.get("failureIndicators") or []),
        common_mistakes=list(raw.get("commonMistakes") or raw.get("common_mistakes") or []),
        counters=list(raw.get("counters") or []),
        counter_adjustments=list(raw.get("counterAdjustments") or []),
        evidence_sources=list(raw.get("evidenceSources") or raw.get("evidence_sources") or []),
        source_type=src,
        control_scheme=str(raw.get("controlScheme") or "any"),
        skill_level=str(raw.get("skillLevel") or raw.get("skill_level") or "all"),
        freshness_days=raw.get("freshnessDays", raw.get("freshness_days")),
        notes=str(raw.get("notes") or ""),
    )
    return True, [], rec


def _slug(s: Any) -> str:
    import re

    return re.sub(r"[^a-z0-9]+", "-", str(s or "x").lower()).strip("-") or "x"
