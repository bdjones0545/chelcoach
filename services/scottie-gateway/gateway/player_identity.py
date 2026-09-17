"""Controlled-player identification — before scoring only.

Privacy: identify in-game controlled skater only. Never real-world identity.
"""
from __future__ import annotations

import copy
import os
import re
from dataclasses import asdict, dataclass, field
from typing import Any

# Configurable threshold (env override for experiments)
DEFAULT_IDENTITY_THRESHOLD = float(os.environ.get("SCOTTIE_IDENTITY_THRESHOLD") or "0.75")
IDENTITY_ERROR = "PLAYER_IDENTITY_UNCONFIRMED"

# No real-world identity fields allowed anywhere in this pipeline
BANNED_IDENTITY_KEYS = frozenset(
    {
        "legalName",
        "realName",
        "name",
        "email",
        "face",
        "age",
        "gender",
        "location",
        "voice",
        "accountId",
        "gamertag",  # not used for ID unless display-only upstream
        "ssn",
        "phone",
    }
)


@dataclass
class FramePlayerDetection:
    frame_index: int
    timestamp: float
    player_id: str  # stable track id within clip
    location: dict[str, float]  # x,y normalized 0-1 center
    team: str | None = None
    jersey_number: int | None = None
    position: str | None = None
    indicator_color: str | None = None
    indicator_icon: str | None = None
    has_control_indicator: bool = False
    detection_confidence: float = 0.5
    continuity_with_prior: float = 0.0
    evidence_type: str = "unknown"  # indicator|jersey|camera|hint|continuity|overlay
    obscured: bool = False
    out_of_frame: bool = False
    on_bench: bool = False

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class ControlledPlayerResult:
    controlled_player_detected: bool
    confidence: float
    game_mode: str = "unknown"
    team_side: str = "unknown"
    position: str = "unknown"
    jersey_number: int | None = None
    indicator_color: str | None = None
    evidence_timestamps: list[float] = field(default_factory=list)
    evidence_summary: list[str] = field(default_factory=list)
    uncertainties: list[str] = field(default_factory=list)
    requires_user_confirmation: bool = False
    identity_source: str = "none"  # visual_verified|user_confirmed|hint_assisted|none
    user_confirmed: bool = False
    track_id: str | None = None
    candidates: list[dict[str, Any]] = field(default_factory=list)
    frame_tracks: list[dict[str, Any]] = field(default_factory=list)

    def to_public_dict(self) -> dict[str, Any]:
        return {
            "controlledPlayerDetected": self.controlled_player_detected,
            "confidence": round(float(self.confidence), 2),
            "gameMode": self.game_mode or "unknown",
            "teamSide": self.team_side or "unknown",
            "position": self.position or "unknown",
            "jerseyNumber": self.jersey_number,
            "indicatorColor": self.indicator_color,
            "evidenceTimestamps": [round(float(t), 3) for t in self.evidence_timestamps],
            "evidenceSummary": list(self.evidence_summary)[:12],
            "uncertainties": list(self.uncertainties)[:12],
            "requiresUserConfirmation": bool(self.requires_user_confirmation),
            "identitySource": self.identity_source,
            "userConfirmed": bool(self.user_confirmed),
            "trackId": self.track_id,
            "candidates": self.candidates[:6],
        }

    def to_attribution_dict(self) -> dict[str, Any]:
        return {
            "controlledPlayerDetected": self.controlled_player_detected,
            "confidence": round(float(self.confidence), 2),
            "position": self.position or "unknown",
            "jerseyNumber": self.jersey_number,
            "indicatorColor": self.indicator_color,
            "identitySource": self.identity_source,
            "userConfirmed": bool(self.user_confirmed),
            "teamSide": self.team_side or "unknown",
            "gameMode": self.game_mode or "unknown",
            "trackId": self.track_id,
        }


def confidence_band(score: float) -> str:
    if score >= 0.90:
        return "very_high"
    if score >= 0.75:
        return "high"
    if score >= 0.60:
        return "moderate"
    if score >= 0.40:
        return "low"
    return "insufficient"


def validate_identity_result(raw: dict[str, Any]) -> tuple[bool, list[str], ControlledPlayerResult | None]:
    """Local schema validation — model/provider output untrusted until this passes."""
    errs: list[str] = []
    if not isinstance(raw, dict):
        return False, ["identity_result_not_object"], None
    for banned in BANNED_IDENTITY_KEYS:
        if banned in raw and raw[banned] not in (None, "", []):
            errs.append(f"banned_field:{banned}")
    try:
        conf = float(raw.get("confidence", raw.get("confidenceScore", -1)))
    except (TypeError, ValueError):
        conf = -1.0
    if not (0.0 <= conf <= 1.0):
        errs.append("confidence_out_of_range")
    detected = bool(raw.get("controlledPlayerDetected", raw.get("controlled_player_detected", False)))
    req = bool(raw.get("requiresUserConfirmation", raw.get("requires_user_confirmation", not detected)))
    jn = raw.get("jerseyNumber", raw.get("jersey_number"))
    if jn is not None:
        try:
            jn = int(jn)
            if jn < 0 or jn > 99:
                errs.append("jersey_out_of_range")
        except (TypeError, ValueError):
            errs.append("jersey_invalid")
            jn = None
    ets = raw.get("evidenceTimestamps") or raw.get("evidence_timestamps") or []
    if not isinstance(ets, list):
        errs.append("evidenceTimestamps_not_list")
        ets = []
    es = raw.get("evidenceSummary") or raw.get("evidence_summary") or []
    if not isinstance(es, list):
        errs.append("evidenceSummary_not_list")
        es = []
    unc = raw.get("uncertainties") or []
    if not isinstance(unc, list):
        errs.append("uncertainties_not_list")
        unc = []
    if detected and conf >= 0.75 and not es and not ets:
        errs.append("high_confidence_without_evidence")
    if errs:
        return False, errs, None
    result = ControlledPlayerResult(
        controlled_player_detected=detected,
        confidence=conf,
        game_mode=str(raw.get("gameMode") or raw.get("game_mode") or "unknown"),
        team_side=str(raw.get("teamSide") or raw.get("team_side") or "unknown"),
        position=str(raw.get("position") or "unknown"),
        jersey_number=jn,
        indicator_color=(
            str(raw["indicatorColor"]).lower()
            if raw.get("indicatorColor") is not None
            else (str(raw["indicator_color"]).lower() if raw.get("indicator_color") is not None else None)
        ),
        evidence_timestamps=[float(t) for t in ets if _is_num(t)],
        evidence_summary=[str(x)[:200] for x in es],
        uncertainties=[str(x)[:200] for x in unc],
        requires_user_confirmation=req,
        identity_source=str(raw.get("identitySource") or raw.get("identity_source") or "none"),
        user_confirmed=bool(raw.get("userConfirmed") or raw.get("user_confirmed")),
        track_id=raw.get("trackId") or raw.get("track_id"),
        candidates=list(raw.get("candidates") or [])[:6],
        frame_tracks=list(raw.get("frameTracks") or raw.get("frame_tracks") or []),
    )
    return True, [], result


def _is_num(v: Any) -> bool:
    try:
        float(v)
        return True
    except (TypeError, ValueError):
        return False


def parse_hint(gameplay_context: dict[str, Any], metadata: dict[str, Any]) -> dict[str, Any]:
    """Optional ChelCoach hints — never trusted alone."""
    hint = {}
    src = {}
    for bag in (gameplay_context or {}, metadata or {}):
        if not isinstance(bag, dict):
            continue
        h = bag.get("controlledPlayerHint") or bag.get("controlled_player_hint") or {}
        if isinstance(h, dict):
            src.update(h)
        for k_src, k_dst in (
            ("gameMode", "game_mode"),
            ("gameTitle", "game_title"),
            ("singlePlayerControl", "single_player_control"),
            ("position", "position"),
            ("jerseyNumber", "jersey_number"),
            ("indicatorColor", "indicator_color"),
            ("teamSide", "team_side"),
        ):
            if k_src in bag and bag[k_src] is not None:
                hint[k_dst] = bag[k_src]
            if k_src in src and src[k_src] is not None:
                hint[k_dst] = src[k_src]
            snake = re.sub(r"([A-Z])", r"_\1", k_src).lower().lstrip("_")
            if snake in bag and bag[snake] is not None:
                hint[k_dst if k_dst else snake] = bag[snake]
            if snake in src and src[snake] is not None:
                hint[k_dst] = src[snake]
    # normalize
    if "jersey_number" in hint and hint["jersey_number"] is not None:
        try:
            hint["jersey_number"] = int(hint["jersey_number"])
        except (TypeError, ValueError):
            hint.pop("jersey_number", None)
    if "indicator_color" in hint and hint["indicator_color"]:
        hint["indicator_color"] = str(hint["indicator_color"]).strip().lower()
    if "position" in hint and hint["position"]:
        hint["position"] = str(hint["position"]).strip().upper()
    if "team_side" in hint and hint["team_side"]:
        hint["team_side"] = str(hint["team_side"]).strip().lower()
    if "game_mode" in hint and hint["game_mode"]:
        hint["game_mode"] = str(hint["game_mode"]).strip()
    # strip banned
    for b in list(hint.keys()):
        if b in BANNED_IDENTITY_KEYS or b.lower() in {x.lower() for x in BANNED_IDENTITY_KEYS}:
            hint.pop(b, None)
    return hint


def load_detections(
    frame_metas: list[dict[str, Any]],
    gameplay_context: dict[str, Any],
    metadata: dict[str, Any],
) -> list[FramePlayerDetection]:
    """Load injected detections (tests/CI) from request context or per-frame meta."""
    raw_list = (
        (gameplay_context or {}).get("playerDetections")
        or (metadata or {}).get("playerDetections")
        or (gameplay_context or {}).get("player_detections")
        or []
    )
    out: list[FramePlayerDetection] = []
    if isinstance(raw_list, list) and raw_list:
        for i, fr in enumerate(raw_list):
            if not isinstance(fr, dict):
                continue
            ts = float(fr.get("timestamp", fr.get("timestampSeconds", 0.0)) or 0.0)
            players = fr.get("players") or fr.get("detections") or []
            if isinstance(fr.get("player"), dict):
                players = [fr["player"]]
            if not isinstance(players, list):
                continue
            for j, p in enumerate(players):
                if not isinstance(p, dict):
                    continue
                loc = p.get("location") or p.get("center") or {}
                if not isinstance(loc, dict):
                    loc = {"x": float(p.get("x", 0.5)), "y": float(p.get("y", 0.5))}
                out.append(
                    FramePlayerDetection(
                        frame_index=int(fr.get("frameIndex", fr.get("index", i))),
                        timestamp=ts,
                        player_id=str(p.get("playerId") or p.get("id") or f"p{j}"),
                        location={
                            "x": float(loc.get("x", 0.5)),
                            "y": float(loc.get("y", 0.5)),
                        },
                        team=(str(p["team"]) if p.get("team") is not None else None),
                        jersey_number=_opt_int(p.get("jerseyNumber", p.get("jersey_number"))),
                        position=(str(p["position"]).upper() if p.get("position") else None),
                        indicator_color=(
                            str(p.get("indicatorColor") or p.get("indicator_color") or "").lower() or None
                        ),
                        indicator_icon=p.get("indicatorIcon") or p.get("indicator_icon"),
                        has_control_indicator=bool(
                            p.get("hasControlIndicator", p.get("has_control_indicator"))
                            or p.get("indicatorColor")
                            or p.get("indicator_color")
                        ),
                        detection_confidence=float(p.get("confidence", p.get("detection_confidence", 0.7))),
                        continuity_with_prior=float(p.get("continuity", p.get("continuity_with_prior", 0.0))),
                        evidence_type=str(p.get("evidenceType") or p.get("evidence_type") or "unknown"),
                        obscured=bool(p.get("obscured")),
                        out_of_frame=bool(p.get("outOfFrame") or p.get("out_of_frame")),
                        on_bench=bool(p.get("onBench") or p.get("on_bench")),
                    )
                )
        return out

    # Per-frame embedded detections on frame_metas
    for i, fm in enumerate(frame_metas or []):
        dets = fm.get("playerDetections") or fm.get("players") or []
        if not isinstance(dets, list):
            continue
        ts = float(fm.get("timestamp") or 0.0)
        for j, p in enumerate(dets):
            if not isinstance(p, dict):
                continue
            loc = p.get("location") or {}
            out.append(
                FramePlayerDetection(
                    frame_index=i,
                    timestamp=ts,
                    player_id=str(p.get("playerId") or p.get("id") or f"f{i}p{j}"),
                    location={"x": float(loc.get("x", 0.5)), "y": float(loc.get("y", 0.5))},
                    team=p.get("team"),
                    jersey_number=_opt_int(p.get("jerseyNumber", p.get("jersey_number"))),
                    position=(str(p["position"]).upper() if p.get("position") else None),
                    indicator_color=(
                        str(p.get("indicatorColor") or p.get("indicator_color") or "").lower() or None
                    ),
                    has_control_indicator=bool(
                        p.get("hasControlIndicator") or p.get("indicatorColor") or p.get("indicator_color")
                    ),
                    detection_confidence=float(p.get("confidence", 0.6)),
                    evidence_type=str(p.get("evidenceType") or "unknown"),
                    obscured=bool(p.get("obscured")),
                    out_of_frame=bool(p.get("outOfFrame")),
                    on_bench=bool(p.get("onBench")),
                )
            )
    return out


def _opt_int(v: Any) -> int | None:
    if v is None or v == "":
        return None
    try:
        return int(v)
    except (TypeError, ValueError):
        return None


def identify_controlled_player(
    *,
    frame_metas: list[dict[str, Any]],
    gameplay_context: dict[str, Any] | None = None,
    metadata: dict[str, Any] | None = None,
    user_confirmation: dict[str, Any] | None = None,
    threshold: float = DEFAULT_IDENTITY_THRESHOLD,
    timestamps: list[float] | None = None,
) -> ControlledPlayerResult:
    """Core identification. Uses detections + hints + optional user confirmation."""
    gameplay_context = gameplay_context or {}
    metadata = metadata or {}
    hint = parse_hint(gameplay_context, metadata)
    game_mode = str(hint.get("game_mode") or gameplay_context.get("gameMode") or metadata.get("gameMode") or "unknown")
    single = hint.get("single_player_control")
    if single is None:
        single = str(game_mode).upper() in ("EASHL", "WORLD OF CHEL", "WOC", "HUT", "BE A PRO", "BAP")

    # User confirmation short-circuit (trusted ChelCoach selection of in-game player only)
    if user_confirmation and user_confirmation.get("confirmed"):
        return _from_user_confirmation(user_confirmation, hint, game_mode, threshold)

    detections = load_detections(frame_metas, gameplay_context, metadata)
    ts_list = timestamps or [float(f.get("timestamp") or 0.0) for f in (frame_metas or [])]

    if not detections:
        # No visual detections available — cannot confidently identify
        unc = ["No player detections available for identification"]
        if hint:
            unc.append("Hints present but video evidence required for verification")
        return ControlledPlayerResult(
            controlled_player_detected=False,
            confidence=0.15 if hint else 0.05,
            game_mode=game_mode,
            team_side=str(hint.get("team_side") or "unknown"),
            position=str(hint.get("position") or "unknown"),
            jersey_number=hint.get("jersey_number"),
            indicator_color=hint.get("indicator_color"),
            evidence_timestamps=[],
            evidence_summary=[],
            uncertainties=unc,
            requires_user_confirmation=True,
            identity_source="none",
            candidates=_hint_only_candidates(hint),
        )

    # Score tracks
    tracks = _group_tracks(detections)
    scored: list[tuple[float, str, dict[str, Any]]] = []
    for tid, frames in tracks.items():
        score, detail = _score_track(frames, hint, game_mode=game_mode, single_player=bool(single))
        scored.append((score, tid, detail))
    scored.sort(key=lambda x: x[0], reverse=True)

    if not scored:
        return ControlledPlayerResult(
            controlled_player_detected=False,
            confidence=0.1,
            game_mode=game_mode,
            requires_user_confirmation=True,
            uncertainties=["No trackable players found"],
            identity_source="none",
        )

    best_score, best_id, best_detail = scored[0]
    second = scored[1][0] if len(scored) > 1 else 0.0
    # Ambiguity: multiple control-like tracks
    ambiguous = False
    if second > 0 and (best_score - second) < 0.10:
        ambiguous = True
        best_score = min(best_score, 0.72)
        best_score = max(0.0, best_score - 0.15)
        best_detail.setdefault("uncertainties", []).append(
            "Multiple skaters match control-like evidence; confirmation required"
        )

    # Conflicting hint vs strong visual indicator
    if hint.get("jersey_number") is not None and best_detail.get("jersey_number") is not None:
        if int(hint["jersey_number"]) != int(best_detail["jersey_number"]) and best_detail.get(
            "indicator_frames", 0
        ) >= 2:
            best_detail.setdefault("uncertainties", []).append(
                "Supplied jersey-number hint conflicts with video indicator track; video preferred"
            )
            # keep video track; slight confidence trim already from mismatch path in scorer

    candidates = []
    for sc, tid, det in scored[:5]:
        candidates.append(
            {
                "trackId": tid,
                "confidence": round(sc, 2),
                "jerseyNumber": det.get("jersey_number"),
                "indicatorColor": det.get("indicator_color"),
                "position": det.get("position"),
                "teamSide": det.get("team_side"),
                "sampleTimestamp": det.get("sample_ts"),
                "evidenceTypes": det.get("evidence_types", []),
            }
        )

    detected = best_score >= threshold and not ambiguous
    if ambiguous:
        best_detail.setdefault("uncertainties", []).append(
            "Ambiguous multi-player control markers"
        )
    result = ControlledPlayerResult(
        controlled_player_detected=detected,
        confidence=min(1.0, max(0.0, best_score)),
        game_mode=game_mode,
        team_side=str(best_detail.get("team_side") or hint.get("team_side") or "unknown"),
        position=str(best_detail.get("position") or hint.get("position") or "unknown"),
        jersey_number=best_detail.get("jersey_number"),
        indicator_color=best_detail.get("indicator_color"),
        evidence_timestamps=list(best_detail.get("evidence_timestamps") or []),
        evidence_summary=list(best_detail.get("evidence_summary") or []),
        uncertainties=list(best_detail.get("uncertainties") or []),
        requires_user_confirmation=not detected or ambiguous,
        identity_source="visual_verified" if detected else "none",
        user_confirmed=False,
        track_id=best_id if detected else None,
        candidates=candidates,
        frame_tracks=[d.to_dict() for d in tracks.get(best_id, [])] if detected else [],
    )
    if not detected:
        if best_score >= 0.40:
            result.uncertainties.append(
                f"Best candidate confidence {best_score:.2f} below threshold {threshold:.2f}"
            )
        if not result.evidence_summary and best_detail.get("evidence_summary"):
            result.evidence_summary = list(best_detail["evidence_summary"])[:6]
        result.evidence_timestamps = list(best_detail.get("evidence_timestamps") or [])[:8]
        # expose best guess in candidates only
        result.track_id = None
        result.identity_source = "none"
    # Mode notes
    if str(game_mode).upper() in ("EASHL", "WORLD OF CHEL", "WOC") and detected:
        result.evidence_summary.append("EASHL/WoC mode: single persistent controlled skater assumed")
    return result


def _from_user_confirmation(
    conf: dict[str, Any],
    hint: dict[str, Any],
    game_mode: str,
    threshold: float,
) -> ControlledPlayerResult:
    # Only in-game attributes
    jn = _opt_int(conf.get("jerseyNumber", conf.get("jersey_number")))
    color = conf.get("indicatorColor") or conf.get("indicator_color")
    if color:
        color = str(color).lower()
    pos = conf.get("position") or hint.get("position") or "unknown"
    if pos:
        pos = str(pos).upper()
    side = conf.get("teamSide") or conf.get("team_side") or hint.get("team_side") or "unknown"
    tid = conf.get("trackId") or conf.get("track_id") or conf.get("selectedPlayerId")
    ts = conf.get("evidenceTimestamps") or conf.get("timestamp") or []
    if _is_num(ts):
        ts = [float(ts)]
    if not isinstance(ts, list):
        ts = []
    return ControlledPlayerResult(
        controlled_player_detected=True,
        confidence=max(threshold, float(conf.get("confidence", 0.95))),
        game_mode=game_mode,
        team_side=str(side).lower(),
        position=str(pos),
        jersey_number=jn,
        indicator_color=color,
        evidence_timestamps=[float(t) for t in ts if _is_num(t)],
        evidence_summary=[
            "User confirmed controlled in-game player selection",
            *(list(conf.get("evidenceSummary") or [])[:4]),
        ],
        uncertainties=[],
        requires_user_confirmation=False,
        identity_source="user_confirmed",
        user_confirmed=True,
        track_id=str(tid) if tid else "user_confirmed",
        candidates=[],
    )


def _hint_only_candidates(hint: dict[str, Any]) -> list[dict[str, Any]]:
    if not hint:
        return []
    return [
        {
            "trackId": None,
            "confidence": 0.2,
            "jerseyNumber": hint.get("jersey_number"),
            "indicatorColor": hint.get("indicator_color"),
            "position": hint.get("position"),
            "teamSide": hint.get("team_side"),
            "note": "hint_only_not_verified",
        }
    ]


def _group_tracks(dets: list[FramePlayerDetection]) -> dict[str, list[FramePlayerDetection]]:
    tracks: dict[str, list[FramePlayerDetection]] = {}
    for d in dets:
        tracks.setdefault(d.player_id, []).append(d)
    for tid in tracks:
        tracks[tid].sort(key=lambda x: (x.timestamp, x.frame_index))
        # fill continuity scores if missing
        prev = None
        for d in tracks[tid]:
            if prev is not None and d.continuity_with_prior <= 0:
                dx = d.location["x"] - prev.location["x"]
                dy = d.location["y"] - prev.location["y"]
                dist = (dx * dx + dy * dy) ** 0.5
                d.continuity_with_prior = max(0.0, 1.0 - min(1.0, dist * 3.0))
            prev = d
    return tracks


def _score_track(
    frames: list[FramePlayerDetection],
    hint: dict[str, Any],
    *,
    game_mode: str,
    single_player: bool,
) -> tuple[float, dict[str, Any]]:
    if not frames:
        return 0.0, {}
    score = 0.0
    evidence_summary: list[str] = []
    evidence_ts: list[float] = []
    unc: list[str] = []
    evidence_types: set[str] = set()

    indicator_frames = [f for f in frames if f.has_control_indicator and not f.out_of_frame]
    # Strongest: control indicator
    if indicator_frames:
        ratio = len(indicator_frames) / max(1, len([f for f in frames if not f.out_of_frame]))
        boost = 0.55 + 0.35 * min(1.0, ratio * 1.5)
        score += boost
        evidence_types.add("indicator")
        colors = [f.indicator_color for f in indicator_frames if f.indicator_color]
        color = _mode(colors)
        evidence_summary.append(
            f"Control indicator visible on track in {len(indicator_frames)} frame(s)"
            + (f" (color={color})" if color else "")
        )
        evidence_ts.extend(f.timestamp for f in indicator_frames[:5])
    else:
        unc.append("Player indicator is not visible in enough frames")

    # Jersey continuity
    jerseys = [f.jersey_number for f in frames if f.jersey_number is not None]
    jersey = _mode(jerseys)
    if jersey is not None:
        score += 0.12
        evidence_types.add("jersey")
        evidence_summary.append(f"Jersey number {jersey} observed on track")
        if hint.get("jersey_number") is not None:
            if int(hint["jersey_number"]) == int(jersey):
                score += 0.10
                evidence_summary.append("Jersey matches supplied hint")
            else:
                score -= 0.15
                unc.append("Jersey on track conflicts with supplied hint")

    # Indicator color vs hint
    colors = [f.indicator_color for f in frames if f.indicator_color]
    color = _mode(colors)
    if color and hint.get("indicator_color"):
        if color == str(hint["indicator_color"]).lower():
            score += 0.10
            evidence_summary.append("Indicator color matches supplied hint")
        else:
            score -= 0.10
            unc.append("Indicator color conflicts with supplied hint")

    # Position hint (weak)
    positions = [f.position for f in frames if f.position]
    position = _mode(positions)
    if position and hint.get("position"):
        if str(position).upper() == str(hint["position"]).upper():
            score += 0.05
            evidence_summary.append("Position alignment matches supplied hint")
        else:
            # weak conflict only
            unc.append("Position hint differs from inferred position")

    # Continuity across frames
    cont = [f.continuity_with_prior for f in frames[1:] if f.continuity_with_prior > 0]
    if cont:
        avg_c = sum(cont) / len(cont)
        score += 0.12 * avg_c
        if avg_c >= 0.6:
            evidence_summary.append("Same player tracked across consecutive frames")
            evidence_types.add("continuity")
        evidence_ts.extend(f.timestamp for f in frames if not f.out_of_frame)

    # Do NOT reward nearest-to-puck or center-camera alone heavily
    centers = [f for f in frames if abs(f.location.get("x", 0.5) - 0.5) < 0.15]
    if centers and not indicator_frames:
        score += 0.03  # weak only
        evidence_types.add("camera")
        unc.append("Camera focus without indicator is weak evidence")

    # Off-puck / obscured / bench still ok if indicator/continuity hold
    if any(f.on_bench for f in frames) and indicator_frames:
        evidence_summary.append("Track accounts for bench/line-change frames")
    if any(f.obscured for f in frames):
        unc.append("Controlled player partially obscured in some frames")
    if any(f.out_of_frame for f in frames):
        # not fatal
        pass

    # single-player mode slight prior for consistent track
    if single_player and len(frames) >= 3:
        score += 0.04

    # Cap and floor
    score = min(0.99, max(0.0, score))
    team = _mode([f.team for f in frames if f.team])
    detail = {
        "jersey_number": jersey,
        "indicator_color": color,
        "position": position or hint.get("position"),
        "team_side": team or hint.get("team_side"),
        "evidence_summary": evidence_summary,
        "evidence_timestamps": sorted(set(round(t, 3) for t in evidence_ts))[:12],
        "uncertainties": unc,
        "indicator_frames": len(indicator_frames),
        "evidence_types": sorted(evidence_types),
        "sample_ts": frames[len(frames) // 2].timestamp,
    }
    return score, detail


def _mode(values: list[Any]) -> Any:
    vals = [v for v in values if v is not None and v != ""]
    if not vals:
        return None
    counts: dict[Any, int] = {}
    for v in vals:
        counts[v] = counts.get(v, 0) + 1
    return sorted(counts.items(), key=lambda kv: (-kv[1], str(kv[0])))[0][0]


def meets_threshold(result: ControlledPlayerResult, threshold: float = DEFAULT_IDENTITY_THRESHOLD) -> bool:
    if result.user_confirmed and result.controlled_player_detected:
        return True
    return bool(result.controlled_player_detected and result.confidence >= threshold)
