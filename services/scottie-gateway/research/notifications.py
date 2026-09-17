"""Notification policy — suppress no-change noise."""
from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

from .models import Finding, utc_iso


NOTIFY_REASONS = (
    "new_title_announced",
    "release_date_changed",
    "title_became_current",
    "major_patch",
    "high_confidence_meta_shift",
    "exploit_wave",
    "approved_knowledge_wrong",
    "source_conflict",
    "production_change_proposed",
)


def should_notify(findings: list[Finding], outcome: str, proposals: list[dict]) -> tuple[bool, str]:
    if proposals:
        return True, "production_change_proposed"
    if outcome == "SOURCE_CONFLICT":
        return True, "source_conflict"
    for f in findings:
        if f.notify:
            return True, f.topic
        if f.source_type == "official" and "patch" in f.topic.lower() and f.confidence == "official":
            return True, "major_patch"
        if f.topic in ("release", "title") and f.confidence in ("official", "high"):
            return True, "new_title_announced"
        if f.status == "corroborated" and f.confidence == "high" and f.production_impact:
            return True, "high_confidence_meta_shift"
    if outcome == "NO_MEANINGFUL_CHANGE":
        return False, "no_change"
    if outcome == "KNOWLEDGE_UPDATED" and not any(f.confidence in ("official", "high") for f in findings):
        return False, "low_signal_update"
    return False, "default_suppress"


def format_slack_message(
    *,
    outcome: str,
    reason: str,
    findings: list[Finding],
    active_game: str,
    production_affected: bool,
    approval_required: bool,
) -> str:
    top = findings[:3]
    lines = [
        f"*Scottie NHL research* — `{outcome}`",
        f"Game: {active_game}",
        f"Why notify: {reason}",
        f"Production behavior affected: {'yes' if production_affected else 'no'}",
        f"Bryan approval required: {'yes' if approval_required else 'no'}",
        "Top findings:",
    ]
    if not top:
        lines.append("- (none)")
    for f in top:
        lines.append(
            f"- [{f.confidence}/{f.status}] {f.claim[:160]} ({f.source_type})"
        )
    return "\n".join(lines)


def emit_notification(
    state_dir: Path,
    message: str,
    *,
    enabled: bool = True,
) -> dict[str, Any]:
    """Write notification artifact; optional webhook if SCOTTIE_SLACK_WEBHOOK set."""
    state_dir.mkdir(parents=True, exist_ok=True)
    path = state_dir / "last_notification.json"
    payload = {"at": utc_iso(), "message": message, "delivered": False, "channel": "file"}
    if not enabled:
        payload["skipped"] = True
        path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
        return payload

    path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    # Also markdown for humans
    (state_dir / "last_notification.md").write_text(message + "\n", encoding="utf-8")

    webhook = (os.environ.get("SCOTTIE_SLACK_WEBHOOK") or "").strip()
    if webhook.startswith("https://"):
        try:
            import urllib.request

            req = urllib.request.Request(
                webhook,
                data=json.dumps({"text": message}).encode(),
                headers={"Content-Type": "application/json"},
                method="POST",
            )
            with urllib.request.urlopen(req, timeout=10) as resp:
                payload["delivered"] = 200 <= resp.status < 300
                payload["channel"] = "slack_webhook"
        except Exception as e:
            payload["error"] = type(e).__name__
        path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    return payload
