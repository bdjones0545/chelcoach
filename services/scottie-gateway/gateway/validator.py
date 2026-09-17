"""Quality gate for Scottie coaching reports."""
from __future__ import annotations

import copy
import re
from typing import Any

from .contracts import (
    METRIC_ICONS,
    METRIC_KEYS,
    METRIC_LABELS,
    format_mmss,
    grade_from_rating,
    tone_for_metric,
)
from .rubric import METRICS, chel_rating_from_metrics, percentile_label

GENERIC_PATTERNS = [
    r"\bjust skate harder\b",
    r"\bgive 110%\b",
    r"\bdo better next time\b",
    r"\bkeep working hard\b",
    r"\btry your best\b",
    r"\bfocus and hustle\b",
]

UNSUPPORTED_CLAIM_PATTERNS = [
    r"\bcontroller\b",
    r"\bbutton (press|mash)",
    r"\bxg\b",
    r"\bexpected goals?\b",
    r"\bplayer id\b",
    r"\breal[- ]?life\b",
    r"\bnhl\.com\b",
    r"\bbetween (the )?frames\b",
    r"\bunseen play\b",
    r"\bhidden (stat|state|meter)\b",
]

BANNED_ABSOLUTES = [
    r"\balways\b",
    r"\bnever\b",
    r"\bguaranteed\b",
]


class ValidationResult:
    def __init__(self) -> None:
        self.errors: list[str] = []
        self.warnings: list[str] = []
        self.report: dict[str, Any] | None = None

    @property
    def ok(self) -> bool:
        return not self.errors and self.report is not None


def _is_nonempty_str(v: Any, min_len: int = 3) -> bool:
    return isinstance(v, str) and len(v.strip()) >= min_len


def _check_generic(text: str, path: str, result: ValidationResult) -> None:
    low = text.lower()
    for pat in GENERIC_PATTERNS:
        if re.search(pat, low):
            result.errors.append(f"{path}: generic advice matched /{pat}/")


def _check_unsupported(text: str, path: str, result: ValidationResult) -> None:
    low = text.lower()
    for pat in UNSUPPORTED_CLAIM_PATTERNS:
        if re.search(pat, low):
            result.errors.append(f"{path}: unsupported claim matched /{pat}/")


def _clamp_int(v: Any, lo: int, hi: int) -> int | None:
    try:
        n = int(round(float(v)))
    except (TypeError, ValueError):
        return None
    return max(lo, min(hi, n))


def validate_report(
    raw: dict[str, Any],
    *,
    frame_timestamps: list[float],
    clip_id: str,
    allow_repair: bool = True,
) -> ValidationResult:
    result = ValidationResult()
    if not isinstance(raw, dict):
        result.errors.append("report must be an object")
        return result

    report = copy.deepcopy(raw)

    # --- metrics ---
    metrics_in = report.get("metrics") or report.get("scorecard", {}).get("metrics")
    metric_scores: dict[str, int] = {}
    normalized_metrics: list[dict[str, Any]] = []

    if isinstance(metrics_in, dict):
        # map key -> value
        for key in METRIC_KEYS:
            if key not in metrics_in and METRIC_LABELS[key] in metrics_in:
                val = metrics_in[METRIC_LABELS[key]]
            else:
                val = metrics_in.get(key)
            n = _clamp_int(val, 0, 100) if val is not None else None
            if n is None:
                result.errors.append(f"metrics.{key}: missing or invalid")
                continue
            metric_scores[key] = n
            note = ""
            if isinstance(metrics_in.get(key), dict):
                note = str(metrics_in[key].get("note") or metrics_in[key].get("detail") or "")
            normalized_metrics.append(_metric_obj(key, n, note))
    elif isinstance(metrics_in, list):
        by_key = {}
        for m in metrics_in:
            if not isinstance(m, dict):
                continue
            key = m.get("key") or _label_to_key(m.get("label", ""))
            if key not in METRIC_KEYS:
                continue
            n = _clamp_int(m.get("value"), 0, 100)
            if n is None:
                result.errors.append(f"metrics.{key}: invalid value")
                continue
            note = str(m.get("note") or "")
            by_key[key] = (n, note)
        for key in METRIC_KEYS:
            if key not in by_key:
                result.errors.append(f"metrics.{key}: missing")
                continue
            n, note = by_key[key]
            metric_scores[key] = n
            normalized_metrics.append(_metric_obj(key, n, note))
    else:
        result.errors.append("metrics missing")

    if len(metric_scores) != len(METRIC_KEYS):
        # already logged missing
        pass

    # --- scorecard fields ---
    scorecard_in = report.get("scorecard") if isinstance(report.get("scorecard"), dict) else {}
    chel = _clamp_int(scorecard_in.get("chelRating") or report.get("chelRating"), 0, 1000)
    derived = chel_rating_from_metrics(metric_scores) if metric_scores else 0
    if chel is None:
        chel = derived
    elif metric_scores and abs(chel - derived) > 80:
        result.warnings.append(
            f"chelRating {chel} diverges from derived {derived}; using derived"
        )
        chel = derived
    elif metric_scores and abs(chel - derived) > 25:
        # gentle correction
        chel = derived

    events = _clamp_int(
        scorecard_in.get("eventsAnalyzed") or report.get("eventsAnalyzed") or len(frame_timestamps),
        0,
        10_000,
    ) or len(frame_timestamps)

    biggest_strength = scorecard_in.get("biggestStrength") or report.get("biggestStrength")
    biggest_weakness = scorecard_in.get("biggestWeakness") or report.get("biggestWeakness")
    if not isinstance(biggest_strength, dict) or not _is_nonempty_str(biggest_strength.get("title")):
        result.errors.append("biggestStrength missing/invalid")
        biggest_strength = {"title": "Not established from frames", "detail": "Insufficient clear strength evidence in sampled frames."}
    if not isinstance(biggest_weakness, dict) or not _is_nonempty_str(biggest_weakness.get("title")):
        result.errors.append("biggestWeakness missing/invalid")
        biggest_weakness = {"title": "Not established from frames", "detail": "Insufficient clear weakness evidence in sampled frames."}

    for path, obj in (("biggestStrength", biggest_strength), ("biggestWeakness", biggest_weakness)):
        for field in ("title", "detail"):
            t = str(obj.get(field) or "")
            _check_generic(t, f"{path}.{field}", result)
            _check_unsupported(t, f"{path}.{field}", result)

    game_context = str(
        scorecard_in.get("gameContext")
        or report.get("gameContext")
        or "Coach-grade breakdown from sampled gameplay frames."
    )

    # --- coaching moments ---
    moments_in = report.get("coachingMoments") or report.get("moments") or []
    if not isinstance(moments_in, list):
        result.errors.append("coachingMoments must be an array")
        moments_in = []
    if len(moments_in) < 1:
        result.errors.append("coachingMoments: need at least 1")
    if len(moments_in) > 8:
        moments_in = moments_in[:8]
        result.warnings.append("coachingMoments truncated to 8")

    seen_titles: set[str] = set()
    moments_out: list[dict[str, Any]] = []
    ts_set = frame_timestamps or [0.0]
    for i, m in enumerate(moments_in):
        if not isinstance(m, dict):
            result.errors.append(f"coachingMoments[{i}]: not object")
            continue
        mtype = m.get("type") or "missed"
        if mtype not in ("great", "missed", "breakdown"):
            result.errors.append(f"coachingMoments[{i}].type invalid")
            mtype = "missed"
        title = str(m.get("title") or "").strip()
        if not title:
            result.errors.append(f"coachingMoments[{i}].title missing")
            title = f"Moment {i+1}"
        tkey = title.lower()
        if tkey in seen_titles:
            result.errors.append(f"coachingMoments[{i}]: duplicate title")
        seen_titles.add(tkey)

        # timestamp: number seconds or mm:ss
        ts_raw = m.get("timestampSeconds", m.get("timestamp"))
        ts_sec = _parse_timestamp(ts_raw, ts_set)
        if ts_sec is None:
            result.errors.append(f"coachingMoments[{i}].timestamp invalid")
            ts_sec = ts_set[min(i, len(ts_set) - 1)]
        # snap to nearest frame if far
        nearest = min(ts_set, key=lambda t: abs(t - ts_sec))
        if abs(nearest - ts_sec) > 3.0 and frame_timestamps:
            result.warnings.append(
                f"coachingMoments[{i}].timestamp {ts_sec}s snapped to nearest frame {nearest}s"
            )
            ts_sec = nearest

        teaser = str(m.get("teaser") or "").strip()
        full = str(m.get("fullBreakdown") or m.get("detail") or "").strip()
        if len(teaser) < 12:
            result.errors.append(f"coachingMoments[{i}].teaser too short")
        if len(full) < 24:
            result.errors.append(f"coachingMoments[{i}].fullBreakdown too short")
        _check_generic(teaser + " " + full, f"coachingMoments[{i}]", result)
        _check_unsupported(teaser + " " + full, f"coachingMoments[{i}]", result)

        # evidence requirement
        evidence = m.get("evidence") or m.get("evidenceClass") or "reasonable_inference"
        if isinstance(evidence, str) and evidence.lower() in ("unsupported", "unknown"):
            result.errors.append(f"coachingMoments[{i}]: evidence class not allowed in report")

        label = {"great": "Great Play", "missed": "Missed Opportunity", "breakdown": "Defensive Breakdown"}[mtype]
        period = str(m.get("period") or "P?")
        moments_out.append(
            {
                "id": str(m.get("id") or f"moment-{i+1}"),
                "type": mtype,
                "label": label,
                "timestamp": format_mmss(ts_sec),
                "period": period,
                "title": title,
                "teaser": teaser,
                "fullBreakdown": full,
            }
        )

    # --- film room ---
    fr_in = report.get("filmRoom") if isinstance(report.get("filmRoom"), dict) else {}
    commentary = str(fr_in.get("commentary") or report.get("commentary") or "").strip()
    if len(commentary) < 40:
        result.errors.append("filmRoom.commentary too short")
    _check_generic(commentary, "filmRoom.commentary", result)
    _check_unsupported(commentary, "filmRoom.commentary", result)

    strengths = fr_in.get("strengths") or report.get("strengths") or []
    mistakes = fr_in.get("mistakes") or report.get("mistakes") or []
    if not isinstance(strengths, list) or len(strengths) < 1:
        result.errors.append("filmRoom.strengths need ≥1")
        strengths = strengths if isinstance(strengths, list) else []
    if not isinstance(mistakes, list) or len(mistakes) < 1:
        result.errors.append("filmRoom.mistakes need ≥1")
        mistakes = mistakes if isinstance(mistakes, list) else []
    strengths = [str(s) for s in strengths[:5] if str(s).strip()]
    mistakes = [str(s) for s in mistakes[:5] if str(s).strip()]
    for i, s in enumerate(strengths):
        _check_unsupported(s, f"strengths[{i}]", result)
    for i, s in enumerate(mistakes):
        _check_unsupported(s, f"mistakes[{i}]", result)

    hia = fr_in.get("highestImpactAdjustment") or report.get("highestImpactAdjustment")
    if not isinstance(hia, dict) or not _is_nonempty_str(hia.get("title")):
        result.errors.append("highestImpactAdjustment missing")
        hia = {
            "title": "Improve reads at the next puck reception",
            "detail": "From the sampled frames, prioritize one clear next action (pass, hold, or move) within the first touch window.",
        }
    _check_generic(str(hia.get("title", "")) + " " + str(hia.get("detail", "")), "highestImpactAdjustment", result)
    _check_unsupported(str(hia.get("title", "")) + " " + str(hia.get("detail", "")), "highestImpactAdjustment", result)

    next_focus = str(fr_in.get("nextGameFocus") or report.get("nextGameFocus") or "").strip()
    if len(next_focus) < 12:
        result.errors.append("nextGameFocus too short")
        next_focus = next_focus or "Win the first controlled play after each retrieval visible in your next session."
    _check_generic(next_focus, "nextGameFocus", result)

    weekly = fr_in.get("weeklySkillFocus") or report.get("weeklySkillFocus") or []
    if not isinstance(weekly, list) or len(weekly) < 1:
        weekly = [
            {
                "title": "Reception scan habit",
                "detail": "Before each touch in practice, check weak-side support once.",
            }
        ]
        result.warnings.append("weeklySkillFocus defaulted")
    weekly_out = []
    for i, w in enumerate(weekly[:4]):
        if not isinstance(w, dict):
            continue
        weekly_out.append(
            {
                "title": str(w.get("title") or f"Focus {i+1}"),
                "detail": str(w.get("detail") or "Practice with intent on the listed habit."),
            }
        )

    markers_in = fr_in.get("markers") or []
    markers_out = []
    if isinstance(markers_in, list):
        for i, mk in enumerate(markers_in[:8]):
            if not isinstance(mk, dict):
                continue
            pos = _clamp_int(mk.get("position"), 0, 100)
            if pos is None:
                continue
            tone = mk.get("tone") if mk.get("tone") in ("good", "warn", "bad") else "warn"
            ts_m = _parse_timestamp(mk.get("timestamp"), ts_set) or ts_set[0]
            markers_out.append(
                {
                    "position": pos,
                    "tone": tone,
                    "label": str(mk.get("label") or f"Mark {i+1}")[:80],
                    "timestamp": format_mmss(ts_m),
                }
            )
    if not markers_out and moments_out:
        # derive from moments
        tmax = max(ts_set) if ts_set else 1.0
        tmax = tmax if tmax > 0 else 1.0
        for m in moments_out:
            sec = _parse_timestamp(m["timestamp"], ts_set) or 0.0
            tone = {"great": "good", "missed": "warn", "breakdown": "bad"}[m["type"]]
            markers_out.append(
                {
                    "position": int(round(min(100, max(0, (sec / tmax) * 100)))),
                    "tone": tone,
                    "label": m["title"][:80],
                    "timestamp": m["timestamp"],
                }
            )

    # confidence consistency
    confidence = report.get("confidence") or scorecard_in.get("confidence")
    if confidence is not None:
        try:
            c = float(confidence)
            if c < 0.2 and len(moments_out) >= 3:
                result.warnings.append("low confidence with many moments")
        except (TypeError, ValueError):
            pass

    # contradiction: strength metric high but biggest weakness same theme? soft check
    # skip hard fail

    impact = fr_in.get("impactMeters") or []
    impact_out = []
    if isinstance(impact, list):
        for im in impact[:4]:
            if not isinstance(im, dict):
                continue
            val = _clamp_int(im.get("value"), 0, 100)
            if val is None:
                continue
            impact_out.append(
                {
                    "label": str(im.get("label") or "Impact")[:60],
                    "detail": str(im.get("detail") or "")[:160],
                    "value": val,
                    "score": str(im.get("score") or f"{val/10:.1f}"),
                    "tone": im.get("tone") if im.get("tone") in ("good", "warn", "bad") else tone_for_metric(val),
                }
            )
    if not impact_out and metric_scores:
        # two meters from metrics
        op = metric_scores.get("offensive_positioning", 50)
        dp = metric_scores.get("defensive_positioning", 50)
        impact_out = [
            {
                "label": "Offensive Threat Rating",
                "detail": "Positioning and puck movement in attack",
                "value": op,
                "score": f"{op/10:.1f}",
                "tone": tone_for_metric(op),
            },
            {
                "label": "Defensive Reliability",
                "detail": "Gap control and defensive structure",
                "value": dp,
                "score": f"{dp/10:.1f}",
                "tone": tone_for_metric(dp),
            },
        ]

    game_summary = fr_in.get("gameSummary") or []
    gs_out = []
    if isinstance(game_summary, list):
        for row in game_summary[:8]:
            if isinstance(row, dict) and row.get("label"):
                gs_out.append({"label": str(row["label"])[:40], "value": str(row.get("value") or "—")[:40]})
    if not gs_out:
        gs_out = [
            {"label": "Frames Analyzed", "value": str(len(frame_timestamps))},
            {"label": "Clip", "value": clip_id[:24]},
            {"label": "Evidence Basis", "value": "Sampled frames only"},
            {"label": "Rubric", "value": "chelcoach-rubric-v1"},
        ]

    matchup = str(fr_in.get("matchup") or report.get("matchup") or "Your Game")
    clip_label = str(fr_in.get("clipLabel") or report.get("clipLabel") or "Clip analysis")
    clip_phase = str(fr_in.get("clipPhase") or report.get("clipPhase") or "Mixed phase")

    # notes on metrics must exist
    for m in normalized_metrics:
        if len(m.get("note") or "") < 8:
            m["note"] = f"Graded from visible structure and puck events on sampled frames ({m['label']})."
        _check_unsupported(m["note"], f"metrics.{m['key']}.note", result)

    if result.errors and not allow_repair:
        return result

    built = {
        "scorecard": {
            "chelRating": int(chel or 0),
            "percentile": percentile_label(int(chel or 0)),
            "overallGrade": grade_from_rating(int(chel or 0)),
            "eventsAnalyzed": int(events),
            "gameContext": game_context[:400],
            "metrics": normalized_metrics,
            "biggestStrength": {
                "title": str(biggest_strength.get("title"))[:120],
                "detail": str(biggest_strength.get("detail"))[:500],
            },
            "biggestWeakness": {
                "title": str(biggest_weakness.get("title"))[:120],
                "detail": str(biggest_weakness.get("detail"))[:500],
            },
        },
        "coachingMoments": moments_out,
        "filmRoom": {
            "matchup": matchup[:120],
            "clipLabel": clip_label[:80],
            "clipPhase": clip_phase[:80],
            "markers": markers_out,
            "commentary": commentary[:1200],
            "strengths": strengths,
            "mistakes": mistakes,
            "highestImpactAdjustment": {
                "title": str(hia.get("title"))[:120],
                "detail": str(hia.get("detail"))[:500],
            },
            "nextGameFocus": next_focus[:400],
            "weeklySkillFocus": weekly_out,
            "gameSummary": gs_out,
            "impactMeters": impact_out,
        },
    }

    # Repair provenance from attempt_repair() — sanitized, never invented here.
    rep = report.get("repair")
    if isinstance(rep, dict) and rep.get("applied") is True:
        built["repair"] = {
            "applied": True,
            "synthesized": [str(x)[:40] for x in (rep.get("synthesized") or []) if isinstance(x, str)][:12],
            "notes": [str(x)[:200] for x in (rep.get("notes") or []) if isinstance(x, str)][:12],
        }

    # Final structural check
    if len(built["scorecard"]["metrics"]) != len(METRIC_KEYS):
        result.errors.append("normalized metrics incomplete")
    if not built["coachingMoments"]:
        result.errors.append("no valid coaching moments after normalize")
    if len(built["filmRoom"]["commentary"]) < 40:
        result.errors.append("commentary still too short")

    # If only soft structural issues remain that we fixed, drop repaired errors for missing fields we filled
    # Keep hard content errors (generic/unsupported)
    hard = [e for e in result.errors if "generic" in e or "unsupported" in e or "duplicate" in e]
    soft = [e for e in result.errors if e not in hard]
    if not hard and built["coachingMoments"] and len(built["scorecard"]["metrics"]) == len(METRIC_KEYS):
        # accept after normalize; convert remaining soft to warnings
        result.warnings.extend(soft)
        result.errors = []
        result.report = built
        return result

    if hard:
        result.errors = hard + [e for e in soft if "missing" in e or "too short" in e or "need" in e]
        result.report = None
        return result

    result.report = built if not result.errors else None
    return result


def attempt_repair(
    raw: dict[str, Any],
    *,
    frame_timestamps: list[float],
    clip_id: str,
    validation: ValidationResult,
) -> dict[str, Any]:
    """Bounded single repair: strip banned phrases, fill gaps, re-clamp."""
    fixed = copy.deepcopy(raw) if isinstance(raw, dict) else {}

    def scrub(text: str) -> str:
        t = text
        for pat in GENERIC_PATTERNS + UNSUPPORTED_CLAIM_PATTERNS:
            t = re.sub(pat, "[removed]", t, flags=re.I)
        return t

    def walk(obj: Any) -> Any:
        if isinstance(obj, dict):
            return {k: walk(v) for k, v in obj.items()}
        if isinstance(obj, list):
            return [walk(x) for x in obj]
        if isinstance(obj, str):
            return scrub(obj)
        return obj

    fixed = walk(fixed)
    # Everything this function invents is recorded here and travels with the report as
    # `repair.synthesized`, so a consumer can tell placeholder content from model output.
    synthesized: list[str] = []

    # Ensure metrics dict present
    if "metrics" not in fixed and not (
        isinstance(fixed.get("scorecard"), dict) and fixed["scorecard"].get("metrics")
    ):
        fixed["metrics"] = {k: 55 for k in METRIC_KEYS}
        synthesized.append("metrics")

    if not fixed.get("coachingMoments"):
        synthesized.append("coachingMoments")
        ts0 = frame_timestamps[0] if frame_timestamps else 0.0
        fixed["coachingMoments"] = [
            {
                "id": "moment-1",
                "type": "missed",
                "title": "Early read opportunity",
                "timestamp": ts0,
                "period": "P?",
                "teaser": "A visible support option appeared near this frame window — review the lane choice.",
                "fullBreakdown": (
                    "On the sampled frames near this timestamp, body orientation and available ice "
                    "suggest a higher-percentage support option than the path taken. Next time, "
                    "check the weak-side lane once before committing to the wall."
                ),
                "evidence": "reasonable_inference",
            }
        ]

    fr = fixed.get("filmRoom") if isinstance(fixed.get("filmRoom"), dict) else {}
    if len(str(fr.get("commentary") or fixed.get("commentary") or "")) < 40:
        synthesized.append("commentary")
        fr["commentary"] = (
            "Across the sampled frames, structure and puck decisions show a mix of solid support "
            "habits and recoverable positioning errors. Prioritize middle-ice awareness on the next "
            "shift sequence and confirm one support option before each retrieval."
        )
        fixed["filmRoom"] = fr
    if not fr.get("strengths") and not fixed.get("strengths"):
        synthesized.append("strengths")
        fr["strengths"] = ["Maintains active stick in several defensive frames"]
        fixed["filmRoom"] = fr
    if not fr.get("mistakes") and not fixed.get("mistakes"):
        synthesized.append("mistakes")
        fr["mistakes"] = ["Occasional over-commitment toward the strong side"]
        fixed["filmRoom"] = fr
    if not fr.get("nextGameFocus") and not fixed.get("nextGameFocus"):
        synthesized.append("nextGameFocus")
        fr["nextGameFocus"] = "Hold middle ice for one extra second before chasing strong-side pressure."
        fixed["filmRoom"] = fr

    # Mark repair. Not an underscore key: validate_report() carries `repair` into the built
    # report and analysis.py leaves it in place, so it reaches ChelCoach.
    fixed["repair"] = {
        "applied": True,
        "synthesized": synthesized,
        "notes": [str(e)[:200] for e in validation.errors[:12]],
    }
    return fixed


def _metric_obj(key: str, value: int, note: str) -> dict[str, Any]:
    return {
        "key": key.replace("_", "-") if False else _key_to_frontend(key),
        "label": METRIC_LABELS[key],
        "value": value,
        "icon": METRIC_ICONS[key],
        "tone": tone_for_metric(value),
        "note": note or f"Graded from visible cues for {METRIC_LABELS[key]}.",
    }


def _key_to_frontend(key: str) -> str:
    # ChelCoach sample uses kebab keys like offensive-iq; we use descriptive kebab
    return key.replace("_", "-")


def _label_to_key(label: str) -> str | None:
    low = label.strip().lower()
    for k, lab in METRIC_LABELS.items():
        if lab.lower() == low or k.replace("_", " ") == low:
            return k
    aliases = {
        "offensive iq": "offensive_positioning",
        "offense": "offensive_positioning",
        "defense": "defensive_positioning",
        "passing": "puck_movement",
        "positioning": "spacing",
        "puck management": "puck_movement",
    }
    return aliases.get(low)


def _parse_timestamp(raw: Any, frame_timestamps: list[float]) -> float | None:
    if raw is None:
        return None
    if isinstance(raw, (int, float)):
        return float(raw)
    s = str(raw).strip()
    if re.fullmatch(r"\d+(\.\d+)?", s):
        return float(s)
    m = re.fullmatch(r"(\d+):(\d{2})(?:\.(\d+))?", s)
    if m:
        return int(m.group(1)) * 60 + int(m.group(2)) + (
            float(f"0.{m.group(3)}") if m.group(3) else 0.0
        )
    return None
