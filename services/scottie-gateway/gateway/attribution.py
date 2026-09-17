"""Attribution quality gate — only grade the controlled player."""
from __future__ import annotations

import re
from typing import Any

from .player_identity import ControlledPlayerResult, meets_threshold

TEAMMATE_BLAME = re.compile(
    r"\b(your teammate|teammate'?s? (turnover|error|mistake)|goalie (let|allowed|mistake|error)|"
    r"opponent'?s? mistake|team (failed|collapsed) because of you without)\b",
    re.I,
)
UNATTRIBUTED_CREDIT = re.compile(
    r"\b(you scored|your goal|you got the assist)\b",
    re.I,
)


def validate_attribution(
    report: dict[str, Any],
    identity: ControlledPlayerResult,
    *,
    frame_timestamps: list[float],
    threshold: float,
) -> tuple[bool, list[str], dict[str, Any] | None]:
    """Ensure report only attributes controlled-player actions and includes playerAttribution."""
    errs: list[str] = []
    if not meets_threshold(identity, threshold) and not identity.user_confirmed:
        return False, ["identity_below_threshold"], None
    if not identity.controlled_player_detected and not identity.user_confirmed:
        return False, ["identity_not_detected"], None

    out = dict(report) if isinstance(report, dict) else {}
    attr = identity.to_attribution_dict()
    # Merge if model provided something, prefer server identity
    existing = out.get("playerAttribution") if isinstance(out.get("playerAttribution"), dict) else {}
    merged = {**existing, **attr}
    out["playerAttribution"] = merged

    # Observations: coachingMoments + optional observations array
    moments = out.get("coachingMoments") or out.get("moments") or []
    if not isinstance(moments, list):
        errs.append("coachingMoments_not_list")
        moments = []

    cleaned_moments = []
    for i, m in enumerate(moments):
        if not isinstance(m, dict):
            errs.append(f"moment[{i}]_not_object")
            continue
        text = " ".join(
            str(m.get(k) or "")
            for k in ("title", "teaser", "fullBreakdown", "detail", "observedAction", "attributionReason")
        )
        if TEAMMATE_BLAME.search(text):
            errs.append(f"moment[{i}]_teammate_or_goalie_blame")
            continue
        # Require attribution fields (add if missing using identity)
        action = str(m.get("observedAction") or m.get("title") or "").strip()
        reason = str(
            m.get("attributionReason")
            or m.get("whyAttributed")
            or _default_attr_reason(identity, m)
        ).strip()
        conf = m.get("attributionConfidence", m.get("confidence", identity.confidence))
        try:
            conf_f = float(conf)
        except (TypeError, ValueError):
            conf_f = float(identity.confidence)
        # timestamp must map to frames
        ts_raw = m.get("timestampSeconds", m.get("timestamp"))
        ts_ok = _timestamp_in_frames(ts_raw, frame_timestamps)
        if not ts_ok:
            errs.append(f"moment[{i}]_timestamp_not_in_frames")
            continue
        # Reject if claims goal credit without attribution link
        if UNATTRIBUTED_CREDIT.search(text) and not m.get("attributionReason") and conf_f < 0.8:
            errs.append(f"moment[{i}]_unattributed_outcome_credit")
            continue
        # Jersey contradiction
        if identity.jersey_number is not None and m.get("jerseyNumber") is not None:
            try:
                if int(m["jerseyNumber"]) != int(identity.jersey_number):
                    errs.append(f"moment[{i}]_jersey_contradiction")
                    continue
            except (TypeError, ValueError):
                pass
        mm = dict(m)
        mm["observedAction"] = action[:200] or mm.get("title") or "observed play"
        mm["attributionReason"] = reason[:300]
        mm["attributionConfidence"] = round(conf_f, 2)
        mm["coachingCategory"] = str(
            mm.get("coachingCategory") or mm.get("category") or _category_from_type(mm.get("type"))
        )
        cleaned_moments.append(mm)

    if not cleaned_moments:
        errs.append("no_attributed_moments")

    out["coachingMoments"] = cleaned_moments

    # Film room commentary scan
    fr = out.get("filmRoom") if isinstance(out.get("filmRoom"), dict) else {}
    for key in ("commentary", "nextGameFocus"):
        t = str(fr.get(key) or "")
        if TEAMMATE_BLAME.search(t):
            errs.append(f"filmRoom.{key}_teammate_blame")
    # mistakes list shouldn't assign teammate errors to user without attribution
    mistakes = fr.get("mistakes") or []
    if isinstance(mistakes, list):
        new_m = []
        for j, item in enumerate(mistakes):
            s = str(item)
            if TEAMMATE_BLAME.search(s) or re.search(r"\bteammate\b.*\byour (fault|grade)\b", s, re.I):
                errs.append(f"mistakes[{j}]_teammate_attribution")
                continue
            new_m.append(item)
        fr["mistakes"] = new_m
        out["filmRoom"] = fr

    # Identity disclosure
    if identity.confidence < 0.9 and not any(
        "confidence" in str(x).lower() for x in (out.get("playerAttribution"),)
    ):
        pass  # already in playerAttribution

    if errs:
        # hard errs that block
        hard = [e for e in errs if not e.startswith("filmRoom.")]
        if hard:
            return False, errs, out
        # soft filmRoom only — still return cleaned
        return True, errs, out
    return True, [], out


def attempt_attribution_repair(
    report: dict[str, Any],
    identity: ControlledPlayerResult,
    errors: list[str],
) -> dict[str, Any]:
    """Bounded repair: drop bad moments, inject attribution fields, scrub blame phrases."""
    out = dict(report) if isinstance(report, dict) else {}
    out["playerAttribution"] = identity.to_attribution_dict()
    moments = out.get("coachingMoments") or []
    fixed = []
    if isinstance(moments, list):
        for m in moments:
            if not isinstance(m, dict):
                continue
            text = " ".join(str(m.get(k) or "") for k in ("title", "teaser", "fullBreakdown", "detail"))
            if TEAMMATE_BLAME.search(text):
                continue
            mm = dict(m)
            mm["attributionReason"] = mm.get("attributionReason") or _default_attr_reason(identity, mm)
            mm["observedAction"] = mm.get("observedAction") or mm.get("title") or "controlled-player action"
            mm["attributionConfidence"] = float(mm.get("attributionConfidence") or identity.confidence)
            mm["coachingCategory"] = mm.get("coachingCategory") or _category_from_type(mm.get("type"))
            # scrub banned phrases lightly
            for k in ("teaser", "fullBreakdown", "detail"):
                if k in mm and isinstance(mm[k], str):
                    mm[k] = TEAMMATE_BLAME.sub("[removed non-user attribution]", mm[k])
            fixed.append(mm)
    if not fixed:
        # create one safe placeholder moment only if identity ok — caller may still fail
        ts = identity.evidence_timestamps[0] if identity.evidence_timestamps else 0.0
        fixed = [
            {
                "id": "moment-attr-1",
                "type": "missed",
                "title": "Controlled-player positioning check",
                "timestamp": ts,
                "timestampSeconds": ts,
                "period": "P?",
                "teaser": "Review the controlled skater's support angle in the sampled frames.",
                "fullBreakdown": (
                    "Attributed to the identified controlled player via verified identity markers. "
                    "Focus on the skater's spacing and next action after reception."
                ),
                "observedAction": "positioning/support",
                "attributionReason": _default_attr_reason(identity, {}),
                "attributionConfidence": float(identity.confidence),
                "coachingCategory": "positioning",
            }
        ]
    out["coachingMoments"] = fixed
    fr = out.get("filmRoom") if isinstance(out.get("filmRoom"), dict) else {}
    if fr:
        mistakes = fr.get("mistakes") or []
        if isinstance(mistakes, list):
            fr["mistakes"] = [m for m in mistakes if not TEAMMATE_BLAME.search(str(m))]
        for key in ("commentary", "nextGameFocus"):
            if key in fr and isinstance(fr[key], str):
                fr[key] = TEAMMATE_BLAME.sub("[removed]", fr[key])
        out["filmRoom"] = fr
    return out


def _default_attr_reason(identity: ControlledPlayerResult, moment: dict[str, Any]) -> str:
    bits = []
    if identity.user_confirmed:
        bits.append("user-confirmed controlled skater")
    if identity.indicator_color:
        bits.append(f"control indicator color={identity.indicator_color}")
    if identity.jersey_number is not None:
        bits.append(f"jersey {identity.jersey_number}")
    if identity.track_id:
        bits.append(f"track {identity.track_id}")
    if not bits:
        bits.append("visual track continuity of controlled skater")
    return "Attributed to controlled player via " + ", ".join(bits)


def _category_from_type(t: Any) -> str:
    return {
        "great": "execution",
        "missed": "decision_making",
        "breakdown": "defensive_positioning",
    }.get(str(t or ""), "general")


def _timestamp_in_frames(raw: Any, frame_timestamps: list[float], tol: float = 3.5) -> bool:
    if raw is None:
        return False
    try:
        if isinstance(raw, str) and ":" in raw:
            parts = raw.split(":")
            ts = int(parts[0]) * 60 + float(parts[1])
        else:
            ts = float(raw)
    except (TypeError, ValueError):
        return False
    if not frame_timestamps:
        return True
    return any(abs(ts - ft) <= tol for ft in frame_timestamps)
