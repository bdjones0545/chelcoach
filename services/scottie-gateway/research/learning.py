"""Internal learning review — bounded window only."""
from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

from . import MAX_FEEDBACK_ITEMS, MAX_INTERNAL_REPORTS
from .models import Finding, default_recheck, finding_id, utc_iso


def review_internal(vault: Path, jobs_dir: Path | None, game_title: str) -> list[Finding]:
    findings: list[Finding] = []
    # Recent analysis job failures / notes from gateway state
    if jobs_dir and jobs_dir.is_dir():
        files = sorted(jobs_dir.glob("*.json"), key=lambda p: p.stat().st_mtime, reverse=True)[
            :MAX_INTERNAL_REPORTS
        ]
        fail_n = 0
        generic_n = 0
        for fp in files:
            try:
                data = json.loads(fp.read_text(encoding="utf-8"))
            except Exception:
                continue
            if data.get("error_code") in ("invalid_report", "provider_failure"):
                fail_n += 1
            # decision journal style signals
        if fail_n >= 3:
            findings.append(
                Finding(
                    finding_id=finding_id("repeated validation failures", "internal", game_title),
                    game_title=game_title,
                    game_version_or_patch="n/a",
                    game_mode="all",
                    topic="quality",
                    claim=f"{fail_n} of last {len(files)} jobs failed validation/provider checks",
                    source_type="internal",
                    source="scottie-jobs",
                    publication_date=utc_iso()[:10],
                    date_discovered=utc_iso()[:10],
                    evidence_summary="Bounded job-store scan; pattern may need prompt/repair review.",
                    confidence="medium",
                    status="candidate",
                    recheck_date=default_recheck("medium", "internal", "quality"),
                    tier=2,
                    production_impact=False,
                    notify=fail_n >= 5,
                )
            )

    # Feedback file — last N bullet-like items
    fb = vault / "learning" / "analysis-feedback.md"
    if fb.is_file():
        lines = [ln.strip() for ln in fb.read_text(encoding="utf-8").splitlines() if ln.strip().startswith("-")]
        for ln in lines[-MAX_FEEDBACK_ITEMS:]:
            if re.search(r"generic|unsupported|timestamp|version.?confus", ln, re.I):
                findings.append(
                    Finding(
                        finding_id=finding_id(ln[:80], "feedback", game_title),
                        game_title=game_title,
                        game_version_or_patch="n/a",
                        game_mode="all",
                        topic="internal_feedback",
                        claim=ln[:240],
                        source_type="internal",
                        source="analysis-feedback.md",
                        publication_date=utc_iso()[:10],
                        date_discovered=utc_iso()[:10],
                        evidence_summary="Explicit feedback log item in bounded window.",
                        confidence="medium",
                        status="candidate",
                        recheck_date=default_recheck("medium", "internal", "feedback"),
                        tier=2,
                    )
                )

    # Decision journal tail
    dj = vault / "decision-journal.md"
    if dj.is_file():
        text = dj.read_text(encoding="utf-8", errors="replace")[-4000:]
        if text.count("validation_failure") >= 3:
            findings.append(
                Finding(
                    finding_id=finding_id("validation_failure cluster", "journal", game_title),
                    game_title=game_title,
                    game_version_or_patch="n/a",
                    game_mode="all",
                    topic="quality",
                    claim="Multiple validation_failure entries in recent decision journal tail",
                    source_type="internal",
                    source="decision-journal.md",
                    publication_date=utc_iso()[:10],
                    date_discovered=utc_iso()[:10],
                    evidence_summary="Journal tail scan only (not full archive).",
                    confidence="medium",
                    status="candidate",
                    recheck_date=default_recheck("medium", "internal", "quality"),
                    tier=2,
                )
            )

    return findings


def ensure_proposal(
    vault: Path,
    *,
    change: str,
    evidence: str,
    game_mode: str,
    confidence: str,
    prior: str,
    proposed: str,
    risks: str,
) -> dict[str, Any] | None:
    """Append one proposal max; never edit rubric files."""
    path = vault / "learning" / "proposed-changes.md"
    path.parent.mkdir(parents=True, exist_ok=True)
    if not path.exists():
        path.write_text("# Proposed Changes\n\n", encoding="utf-8")
    body = path.read_text(encoding="utf-8")
    # skip exact duplicate change text
    if change in body:
        return None
    pid = finding_id(change, "proposal", game_mode) 
    block = f"""
## {pid} — {utc_iso()[:10]}

- **proposed change:** {change}
- **evidence:** {evidence[:500]}
- **affected game/mode:** {game_mode}
- **expected benefit:** clearer coaching alignment with verified meta
- **risks:** {risks}
- **prior behavior:** {prior}
- **proposed behavior:** {proposed}
- **confidence:** {confidence}
- **rollback plan:** revert this proposal entry; restore prior guidance text
- **approval status:** pending_bryan_review
"""
    with path.open("a", encoding="utf-8") as f:
        f.write(block)
    return {"id": pid, "status": "pending_bryan_review", "change": change}
