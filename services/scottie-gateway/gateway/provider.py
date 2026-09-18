"""Provider adapter layer — fake (default/CI) + OpenAI-compatible vision."""
from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from typing import Any, Protocol

from .chat import MAX_REPLY_TOKENS, ChatResult, build_messages, fake_reply
from .contracts import METRIC_KEYS, format_mmss
from .rubric import METRICS, chel_rating_from_metrics, rubric_prompt_block


@dataclass
class ProviderResult:
    ok: bool
    report: dict[str, Any] | None = None
    error: str = ""
    provider: str = ""
    model: str = ""
    input_tokens: int = 0
    output_tokens: int = 0
    latency_ms: int = 0
    retries: int = 0
    raw_text: str = field(default="", repr=False)


class Provider(Protocol):
    name: str

    def analyze(
        self,
        *,
        frames_meta: list[dict[str, Any]],
        metadata: dict[str, Any],
        gameplay_context: dict[str, Any],
        jpeg_payloads: list[bytes] | None = None,
    ) -> ProviderResult: ...

    def chat(self, *, report_context: dict[str, Any], turns: list[dict[str, str]]) -> ChatResult: ...


def system_prompt() -> str:
    return f"""You are Scottie, Senior NHL Gameplay Analysis Specialist for ChelCoach.
Analyze ONLY the provided gameplay frames. Do not invent events between frames.
Evidence classes: directly_observable | reasonable_inference only in outputs.
Never claim controller input, player real-world identity (name, face, age, gender, location), hidden meters, xG, or unseen plays.
Grade ONLY the controlled in-game skater identified in context. Do not blame teammate turnovers, goalie errors, or opponent mistakes on the user.
Each coaching moment must include observedAction, attributionReason, attributionConfidence, coachingCategory, and a timestamp in supplied frames.
Include playerAttribution in the report.
Acknowledge uncertainty when frames are sparse.

{rubric_prompt_block()}

Return a single JSON object (no markdown) with this shape:
{{
  "metrics": {{
    "offensive_positioning": 0-100,
    "defensive_positioning": 0-100,
    "decision_making": 0-100,
    "puck_movement": 0-100,
    "spacing": 0-100,
    "transition_play": 0-100
  }},
  "metricNotes": {{ "<metric_key>": "evidence-tied note" }},
  "chelRating": 0-1000,
  "biggestStrength": {{"title":"","detail":""}},
  "biggestWeakness": {{"title":"","detail":""}},
  "gameContext": "",
  "coachingMoments": [
    {{
      "id": "moment-1",
      "type": "great|missed|breakdown",
      "title": "",
      "timestampSeconds": 0.0,
      "period": "P1",
      "teaser": "",
      "fullBreakdown": "",
      "evidence": "directly_observable|reasonable_inference"
    }}
  ],
  "filmRoom": {{
    "matchup": "",
    "clipLabel": "",
    "clipPhase": "",
    "commentary": "",
    "strengths": ["", ""],
    "mistakes": ["", ""],
    "highestImpactAdjustment": {{"title":"","detail":""}},
    "nextGameFocus": "",
    "weeklySkillFocus": [{{"title":"","detail":""}}],
    "markers": [{{"position":0,"tone":"good|warn|bad","label":"","timestamp":"0:00"}}],
    "impactMeters": [],
    "gameSummary": []
  }},
  "confidence": 0.0
}}
Every recommendation must reference observable frame evidence (timestamp or frame index).
"""


class FakeProvider:
    """Deterministic provider for CI and local integration. Never calls paid APIs."""

    name = "fake"

    def __init__(self, model: str | None = None) -> None:
        self.model = model or "fake-scottie-v1"

    def analyze(
        self,
        *,
        frames_meta: list[dict[str, Any]],
        metadata: dict[str, Any],
        gameplay_context: dict[str, Any],
        jpeg_payloads: list[bytes] | None = None,
    ) -> ProviderResult:
        t0 = time.time()
        n = max(1, len(frames_meta))
        # Deterministic scores from frame count + metadata seed
        seed = sum(int(f.get("size_bytes") or 0) for f in frames_meta) + n * 17
        scores = {}
        for i, key in enumerate(METRIC_KEYS):
            base = 52 + ((seed >> (i * 3)) % 41)  # 52-92
            scores[key] = int(base)
        chel = chel_rating_from_metrics(scores)
        ts_list = [float(f.get("timestamp") or 0.0) for f in frames_meta]
        t_mid = ts_list[len(ts_list) // 2]
        t_lo = ts_list[0]
        t_hi = ts_list[-1]
        matchup = str(
            gameplay_context.get("matchup")
            or metadata.get("matchup")
            or "Your Game — sampled clip"
        )
        notes = {
            k: f"Based on visible structure across {n} frames; {METRICS[k]['label']} cues graded conservatively."
            for k in METRIC_KEYS
        }
        cp = gameplay_context.get("controlledPlayer") if isinstance(gameplay_context, dict) else None
        if not isinstance(cp, dict):
            cp = {}
        attr_reason = (
            "Attributed to controlled player via "
            + (
                f"indicator={cp.get('indicatorColor')}, jersey={cp.get('jerseyNumber')}"
                if cp
                else "verified control track"
            )
        )
        conf = float(cp.get("confidence") or 0.9)
        report = {
            "metrics": scores,
            "metricNotes": notes,
            "chelRating": chel,
            "biggestStrength": {
                "title": "Support availability in transition frames",
                "detail": (
                    f"Around {format_mmss(t_mid)}, the controlled skater's nearby support options and open ice lanes are visible, "
                    "supporting a positive read on support spacing versus isolation carries."
                ),
            },
            "biggestWeakness": {
                "title": "Strong-side over-commitment risk",
                "detail": (
                    f"Near {format_mmss(t_hi)}, the controlled skater's body orientation trends toward the puck-side wall "
                    "while middle ice looks lighter — a recoverable positioning habit on the next retrieval."
                ),
            },
            "gameContext": str(
                gameplay_context.get("description")
                or metadata.get("gameContext")
                or f"Frame-sampled NHL gameplay analysis ({n} frames)."
            ),
            "playerAttribution": cp
            or {
                "controlledPlayerDetected": True,
                "confidence": 0.9,
                "identitySource": "visual_verified",
                "userConfirmed": False,
            },
            "coachingMoments": [
                {
                    "id": "moment-1",
                    "type": "great",
                    "title": "Clean support angle",
                    "timestampSeconds": t_lo,
                    "period": str(gameplay_context.get("period") or "P?"),
                    "teaser": "Early frames show a usable support angle that keeps an outlet alive under pressure.",
                    "fullBreakdown": (
                        f"At {format_mmss(t_lo)}, the controlled skater's positioning relative to the puck and nearest "
                        "teammate preserves a short outlet. Maintain this distance rather than collapsing onto the same hash marks."
                    ),
                    "evidence": "directly_observable",
                    "observedAction": "support positioning / outlet angle",
                    "attributionReason": attr_reason,
                    "attributionConfidence": conf,
                    "coachingCategory": "spacing",
                },
                {
                    "id": "moment-2",
                    "type": "missed",
                    "title": "Weak-side scan window",
                    "timestampSeconds": t_mid,
                    "period": str(gameplay_context.get("period") or "P?"),
                    "teaser": "A brief weak-side lane appears in the middle sample — easy to miss without a pre-touch check.",
                    "fullBreakdown": (
                        f"Near {format_mmss(t_mid)}, open ice opposite the puck side is visible for a short window. "
                        "A single shoulder check before the next reception would make that option available without a forced rim."
                    ),
                    "evidence": "reasonable_inference",
                    "observedAction": "pre-touch scan / decision making",
                    "attributionReason": attr_reason,
                    "attributionConfidence": conf,
                    "coachingCategory": "decision_making",
                },
                {
                    "id": "moment-3",
                    "type": "breakdown",
                    "title": "Middle-lane vacancy",
                    "timestampSeconds": t_hi,
                    "period": str(gameplay_context.get("period") or "P?"),
                    "teaser": "Late frames show middle ice opening as pressure chases strong side.",
                    "fullBreakdown": (
                        f"By {format_mmss(t_hi)}, the controlled skater's chase pressure toward the wall leaves the middle lighter. "
                        "Holding the middle for one extra second forces play outside and reduces high-danger seams."
                    ),
                    "evidence": "reasonable_inference",
                    "observedAction": "defensive middle-lane hold",
                    "attributionReason": attr_reason,
                    "attributionConfidence": conf,
                    "coachingCategory": "defensive_positioning",
                },
            ],
            "filmRoom": {
                "matchup": matchup,
                "clipLabel": str(metadata.get("clipLabel") or f"{n}-frame sample"),
                "clipPhase": str(gameplay_context.get("phase") or "Mixed phase"),
                "commentary": (
                    "The sampled frames show the controlled skater with competent support habits mixed with occasional strong-side chase. "
                    "Puck decisions look deliberate on early touches; late-sequence positioning is the higher-leverage fix. "
                    "Treat every retrieval as a two-option problem: middle hold versus wall pressure."
                ),
                "strengths": [
                    "Outlet support distance stays playable in early frames",
                    "Active stick posture appears in several defensive snapshots",
                    "Pace of first touch is generally calm under light pressure",
                ],
                "mistakes": [
                    "Strong-side gravity late in the sequence",
                    "Middle ice left lighter after chase",
                    "Weak-side option not always oriented before reception",
                ],
                "highestImpactAdjustment": {
                    "title": "Hold middle ice one beat longer",
                    "detail": (
                        "On the next shift, delay the wall chase by one second after a retrieval. "
                        "The sampled end-sequence shows how quickly seams open when middle ice empties."
                    ),
                },
                "nextGameFocus": "Win the first controlled play after each retrieval — middle first, wall second.",
                "weeklySkillFocus": [
                    {
                        "title": "Pre-touch weak-side check",
                        "detail": "In practice, require one weak-side glance before every reception in NZ/OZ drills.",
                    },
                    {
                        "title": "Middle-lane holds",
                        "detail": "Small-area game: score only counts if F2 holds middle until puck is below the goal line.",
                    },
                ],
                "markers": [
                    {
                        "position": 15,
                        "tone": "good",
                        "label": "Support angle",
                        "timestamp": format_mmss(t_lo),
                    },
                    {
                        "position": 50,
                        "tone": "warn",
                        "label": "Scan window",
                        "timestamp": format_mmss(t_mid),
                    },
                    {
                        "position": 85,
                        "tone": "bad",
                        "label": "Middle vacancy",
                        "timestamp": format_mmss(t_hi),
                    },
                ],
                "impactMeters": [],
                "gameSummary": [],
            },
            "confidence": 0.72 if n >= 6 else 0.55,
        }
        # Attach notes onto metrics list form for validator path flexibility
        report["metrics"] = [
            {"key": k, "value": scores[k], "note": notes[k]} for k in METRIC_KEYS
        ]
        latency = int((time.time() - t0) * 1000)
        return ProviderResult(
            ok=True,
            report=report,
            provider=self.name,
            model=self.model,
            input_tokens=0,
            output_tokens=0,
            latency_ms=latency,
            retries=0,
        )


    def chat(self, *, report_context: dict[str, Any], turns: list[dict[str, str]]) -> ChatResult:
        t0 = time.time()
        return ChatResult(
            ok=True,
            reply=fake_reply(report_context, turns),
            provider=self.name,
            model=self.model,
            latency_ms=int((time.time() - t0) * 1000),
        )


class OpenAICompatibleVisionProvider:
    """Optional real provider via OpenAI-compatible chat/completions with images."""

    name = "openai_compatible"

    def __init__(
        self,
        *,
        api_key: str,
        model: str,
        base_url: str = "https://api.openai.com/v1",
        timeout_s: float = 90.0,
        retries: int = 1,
    ) -> None:
        self.api_key = api_key
        self.model = model
        self.base_url = base_url.rstrip("/")
        self.timeout_s = timeout_s
        self.retries = max(0, retries)

    def analyze(
        self,
        *,
        frames_meta: list[dict[str, Any]],
        metadata: dict[str, Any],
        gameplay_context: dict[str, Any],
        jpeg_payloads: list[bytes] | None = None,
    ) -> ProviderResult:
        import base64

        if not jpeg_payloads:
            return ProviderResult(ok=False, error="no_frames", provider=self.name, model=self.model)

        content: list[dict[str, Any]] = [
            {
                "type": "text",
                "text": json.dumps(
                    {
                        "metadata": metadata,
                        "gameplayContext": gameplay_context,
                        "frames": [
                            {
                                "index": f.get("index"),
                                "timestampSeconds": f.get("timestamp"),
                                "width": f.get("width"),
                                "height": f.get("height"),
                            }
                            for f in frames_meta
                        ],
                        "instruction": "Analyze these ordered JPEG frames and return the JSON report only.",
                    }
                ),
            }
        ]
        for i, data in enumerate(jpeg_payloads):
            b64 = base64.b64encode(data).decode("ascii")
            content.append(
                {
                    "type": "image_url",
                    "image_url": {"url": f"data:image/jpeg;base64,{b64}"},
                }
            )
            content.append(
                {
                    "type": "text",
                    "text": f"Frame index={i} timestampSeconds={frames_meta[i].get('timestamp')}",
                }
            )

        body = {
            "model": self.model,
            "temperature": 0.2,
            "response_format": {"type": "json_object"},
            "messages": [
                {"role": "system", "content": system_prompt()},
                {"role": "user", "content": content},
            ],
        }
        raw_body = json.dumps(body).encode("utf-8")
        url = f"{self.base_url}/chat/completions"
        attempts = 0
        last_err = ""
        t0 = time.time()
        while attempts <= self.retries:
            attempts += 1
            req = urllib.request.Request(
                url,
                data=raw_body,
                method="POST",
                headers={
                    "Authorization": f"Bearer {self.api_key}",
                    "Content-Type": "application/json",
                    "User-Agent": "scottie-gateway/1.0",
                },
            )
            try:
                with urllib.request.urlopen(req, timeout=self.timeout_s) as resp:
                    payload = json.loads(resp.read().decode("utf-8"))
                text = payload["choices"][0]["message"]["content"]
                usage = payload.get("usage") or {}
                report = json.loads(text)
                return ProviderResult(
                    ok=True,
                    report=report,
                    provider=self.name,
                    model=self.model,
                    input_tokens=int(usage.get("prompt_tokens") or 0),
                    output_tokens=int(usage.get("completion_tokens") or 0),
                    latency_ms=int((time.time() - t0) * 1000),
                    retries=attempts - 1,
                    raw_text="",  # do not keep
                )
            except urllib.error.HTTPError as e:
                last_err = f"http_{e.code}"
                time.sleep(min(2 * attempts, 5))
            except Exception as e:  # noqa: BLE001
                last_err = type(e).__name__
                time.sleep(min(2 * attempts, 5))
        return ProviderResult(
            ok=False,
            error=last_err or "provider_failed",
            provider=self.name,
            model=self.model,
            latency_ms=int((time.time() - t0) * 1000),
            retries=max(0, attempts - 1),
        )


    def chat(self, *, report_context: dict[str, Any], turns: list[dict[str, str]]) -> ChatResult:
        """Text-only chat/completions over the report; no images, no JSON mode, bounded reply."""
        body = {
            "model": self.model,
            "temperature": 0.4,
            "max_tokens": MAX_REPLY_TOKENS,
            "messages": build_messages(report_context, turns),
        }
        raw_body = json.dumps(body).encode("utf-8")
        url = f"{self.base_url}/chat/completions"
        attempts = 0
        last_err = ""
        t0 = time.time()
        while attempts <= self.retries:
            attempts += 1
            req = urllib.request.Request(
                url,
                data=raw_body,
                method="POST",
                headers={
                    "Authorization": f"Bearer {self.api_key}",
                    "Content-Type": "application/json",
                    "User-Agent": "scottie-gateway/1.0",
                },
            )
            try:
                with urllib.request.urlopen(req, timeout=self.timeout_s) as resp:
                    payload = json.loads(resp.read().decode("utf-8"))
                text = str(payload["choices"][0]["message"]["content"] or "").strip()
                if not text:
                    last_err = "empty_reply"
                    continue
                usage = payload.get("usage") or {}
                return ChatResult(
                    ok=True,
                    reply=text,
                    provider=self.name,
                    model=self.model,
                    input_tokens=int(usage.get("prompt_tokens") or 0),
                    output_tokens=int(usage.get("completion_tokens") or 0),
                    latency_ms=int((time.time() - t0) * 1000),
                )
            except urllib.error.HTTPError as e:
                last_err = f"http_{e.code}"
                time.sleep(min(2 * attempts, 5))
            except Exception as e:  # noqa: BLE001
                last_err = type(e).__name__
                time.sleep(min(2 * attempts, 5))
        return ChatResult(ok=False, error=last_err or "provider_failed", provider=self.name, model=self.model, latency_ms=int((time.time() - t0) * 1000))


def build_provider(cfg: dict[str, Any]) -> Provider:
    name = (cfg.get("provider") or "fake").lower()
    if name in ("fake", "test", "mock"):
        return FakeProvider(model=cfg.get("provider_model"))
    if name in ("openai", "openai_compatible", "openrouter", "xai", "anthropic_compat"):
        api_key = (
            os.environ.get("SCOTTIE_PROVIDER_API_KEY")
            or os.environ.get("OPENAI_API_KEY")
            or os.environ.get("OPENROUTER_API_KEY")
            or os.environ.get("XAI_API_KEY")
            or ""
        ).strip()
        if not api_key:
            # Fail safe to fake only if explicitly allowed
            if os.environ.get("SCOTTIE_ALLOW_FAKE_FALLBACK", "0") == "1":
                return FakeProvider()
            raise RuntimeError("SCOTTIE_PROVIDER_API_KEY required for non-fake provider")
        base = (
            os.environ.get("SCOTTIE_PROVIDER_BASE_URL")
            or os.environ.get("OPENAI_BASE_URL")
            or "https://api.openai.com/v1"
        )
        model = cfg.get("provider_model") or os.environ.get("SCOTTIE_PROVIDER_MODEL") or "gpt-4o"
        return OpenAICompatibleVisionProvider(
            api_key=api_key,
            model=model,
            base_url=base,
            timeout_s=float(cfg.get("provider_timeout_s") or 90),
            retries=int(cfg.get("provider_retries") or 1),
        )
    raise RuntimeError(f"Unknown SCOTTIE_PROVIDER: {name}")
