"""Main daily research loop orchestration."""
from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from . import MAX_CREATORS, MAX_REDDIT, PROTECTED_ACTIONS
from .budget import Budget
from .learning import ensure_proposal, review_internal
from .models import (
    Finding,
    community_ceiling,
    day_stamp,
    default_recheck,
    finding_id,
    is_expired,
    scrub_untrusted_text,
    utc_iso,
)
from .notifications import emit_notification, format_slack_message, should_notify
from .runtime_context import build_runtime_context
from .sources import FixtureAdapter, LiveAdapter, SourceAdapter, SourceDoc


DEFAULT_VAULT = Path("/root/Desktop/Kevin/Agents/Scottie")
DEFAULT_STATE = Path("/root/.hermes/profiles/scottie/state/research")
DEFAULT_JOBS = Path("/root/.hermes/profiles/scottie/state/jobs")


@dataclass
class LoopResult:
    outcome: str
    active_game: str
    findings: list[Finding] = field(default_factory=list)
    sources_checked: list[str] = field(default_factory=list)
    budget: dict = field(default_factory=dict)
    proposals: list[dict] = field(default_factory=list)
    files_written: list[str] = field(default_factory=list)
    notification: dict | None = None
    daily_path: str = ""
    dry_run: bool = False
    notes: list[str] = field(default_factory=list)
    estimated_tokens: int = 0

    def to_dict(self) -> dict[str, Any]:
        return {
            "outcome": self.outcome,
            "active_game": self.active_game,
            "findings": [f.to_dict() for f in self.findings],
            "sources_checked": self.sources_checked,
            "budget": self.budget,
            "proposals": self.proposals,
            "files_written": self.files_written,
            "notification": self.notification,
            "daily_path": self.daily_path,
            "dry_run": self.dry_run,
            "notes": self.notes,
            "estimated_tokens": self.estimated_tokens,
        }


def run_daily_research(
    *,
    vault: Path = DEFAULT_VAULT,
    state_dir: Path = DEFAULT_STATE,
    jobs_dir: Path | None = DEFAULT_JOBS,
    adapter: SourceAdapter | None = None,
    mode: str = "fixture",  # fixture | live | dry-run
    fixture: dict | None = None,
    fixture_path: Path | None = None,
    write_files: bool | None = None,
    force_date: str | None = None,
) -> LoopResult:
    dry_run = mode == "dry-run" or (write_files is False)
    if write_files is None:
        write_files = mode in ("fixture", "live") and not dry_run
    # dry-run with live adapter still can write daily report if write_files True — default dry-run no write except report optional
    if mode == "dry-run":
        write_files = False if write_files is None else write_files

    budget = Budget()
    if adapter is None:
        if mode in ("live", "dry-run"):
            # dry-run = live reads, no vault writes (unless write_files forced)
            adapter = LiveAdapter()
        else:
            adapter = FixtureAdapter(fixture=fixture, path=fixture_path)

    notes: list[str] = []
    sources_checked: list[str] = []
    findings: list[Finding] = []
    incomplete = False
    conflicts: list[str] = []

    active = _read_active_game(vault)
    game_title = active.get("title") or "unknown"
    game_slug = active.get("slug") or "unknown"

    # --- Tier 1 official searches (bounded topics, no duplicates) ---
    official_topics = [
        ("official_current_title", f"EA Sports NHL current game official site {day_stamp()}"),
        ("official_patch_notes", "EA Sports NHL patch notes official sitewide"),
        ("official_announcements", "EA Sports NHL announcement trailer OR title official"),
    ]
    official_docs: list[SourceDoc] = []
    for key, q in official_topics:
        if not budget.can_search(key):
            break
        try:
            docs = adapter.search(budget, key, q)
            sources_checked.append(f"search:{key}:{len(docs)}")
            official_docs.extend(docs)
        except RuntimeError as e:
            notes.append(str(e))
            incomplete = True
            break

    # Always try a small official seed set (live or fixture pages) — cheap, high-signal
    seed_urls = [
        "https://www.ea.com/games/nhl",
        "https://www.ea.com/games/nhl/nhl-26",
        "https://www.ea.com/games/nhl/nhl-26/news",
        "https://www.ea.com/games/nhl/nhl-25",
    ]
    # Include fixture-provided official URLs from search hits first
    for d in list(official_docs):
        if d.tier == 1 and d.url and d.url not in seed_urls:
            seed_urls.append(d.url)
    opened = 0
    for url in seed_urls:
        if not budget.can_page():
            break
        if opened >= 8:
            break
        try:
            page = adapter.open_page(budget, url)
        except Exception:
            page = None
        sources_checked.append(f"page:{url[:80]}")
        if page:
            official_docs.append(page)
            opened += 1
        elif incomplete is False and adapter.name == "live":
            # soft fail only
            notes.append(f"page_miss:{url[:60]}")

    findings.extend(_extract_official_findings(official_docs, game_title))

    # Bounded control-change signal check (same daily job — no second cron)
    try:
        import sys
        from pathlib import Path as _P

        _svc = _P(__file__).resolve().parents[1]
        if str(_svc) not in sys.path:
            sys.path.insert(0, str(_svc))
        from controls.research_hook import scan_docs_for_control_signals

        ctrl_scan = scan_docs_for_control_signals(official_docs)
        notes.append(f"controls_signal={ctrl_scan.get('control_change_signal')}")
        sources_checked.append(f"controls_scan:hits={len(ctrl_scan.get('hits') or [])}")
        if ctrl_scan.get("deep_research_recommended"):
            notes.append("controls_deep_research_recommended")
            # do not auto-promote mappings — vault note only when writing
            if write_files:
                try:
                    cpath = vault / "controls" / "unverified-controls.md"
                    cpath.parent.mkdir(parents=True, exist_ok=True)
                    with cpath.open("a", encoding="utf-8") as fh:
                        fh.write(f"\n- {day_stamp()}: control-change signal in official sources; verify before promote\n")
                        for h in (ctrl_scan.get("hits") or [])[:3]:
                            fh.write(f"  - {h.get('url')}: {h.get('excerpt','')[:100]}\n")
                except OSError:
                    pass
    except Exception as e:  # noqa: BLE001
        notes.append(f"controls_scan_skip:{type(e).__name__}")

    # Bounded faceoff signal check (same daily job)
    try:
        import sys
        from pathlib import Path as _P

        _svc = _P(__file__).resolve().parents[1]
        if str(_svc) not in sys.path:
            sys.path.insert(0, str(_svc))
        from faceoffs.engine import scan_docs_for_faceoff_signals

        fo_scan = scan_docs_for_faceoff_signals(official_docs)
        notes.append(f"faceoff_signal={fo_scan.get('faceoff_signal')}")
        sources_checked.append(f"faceoff_scan:hits={len(fo_scan.get('hits') or [])}")
        if fo_scan.get("deep_research_recommended") and write_files:
            try:
                fpath = vault / "faceoffs" / "patch-history.md"
                fpath.parent.mkdir(parents=True, exist_ok=True)
                with fpath.open("a", encoding="utf-8") as fh:
                    fh.write(f"\n| {day_stamp()} | signal | faceoff mention in official sources | research | open |\n")
                    for h in (fo_scan.get("hits") or [])[:3]:
                        fh.write(f"|  |  | {str(h.get('excerpt',''))[:80]} | {h.get('url','')} | open |\n")
            except OSError:
                pass
    except Exception as e:  # noqa: BLE001
        notes.append(f"faceoff_scan_skip:{type(e).__name__}")

    # Bounded strategy-meta signal check (same daily job — no second cron)
    try:
        import sys
        from pathlib import Path as _P

        _svc = _P(__file__).resolve().parents[1]
        if str(_svc) not in sys.path:
            sys.path.insert(0, str(_svc))
        from strategies.research_hook import scan_docs_for_strategy_signals

        st_scan = scan_docs_for_strategy_signals(official_docs)
        notes.append(f"strategy_signal={st_scan.get('strategy_signal')}")
        notes.append(f"title_announce_signal={st_scan.get('title_announce_signal')}")
        notes.append(f"title_release_signal={st_scan.get('title_release_signal')}")
        sources_checked.append(f"strategy_scan:hits={len(st_scan.get('hits') or [])}")
        if st_scan.get("deep_research_recommended"):
            notes.append("strategy_deep_research_recommended")
        if write_files and st_scan.get("strategy_signal"):
            try:
                cpath = vault / "games" / (active.get("slug") or "unknown") / "meta" / "candidate-findings.md"
                cpath.parent.mkdir(parents=True, exist_ok=True)
                with cpath.open("a", encoding="utf-8") as fh:
                    fh.write(f"\n- {day_stamp()}: strategy signal in official sources (candidate only)\n")
                    for h in (st_scan.get("hits") or [])[:3]:
                        fh.write(f"  - {h.get('url')}: {h.get('excerpt','')[:100]}\n")
            except OSError:
                pass
    except Exception as e:  # noqa: BLE001
        notes.append(f"strategy_scan_skip:{type(e).__name__}")

    # --- Tier 2 competitive (1 search) ---
    if budget.can_search("competitive_meta"):
        try:
            comp = adapter.search(
                budget,
                "competitive_meta",
                f"{game_title} competitive meta EASHL OR HUT strategy",
            )
            sources_checked.append(f"search:competitive_meta:{len(comp)}")
            findings.extend(_extract_community_findings(comp, game_title, default_conf="medium", source_type="competitive"))
        except RuntimeError as e:
            notes.append(str(e))

    # --- Tier 3 Reddit (bounded) ---
    reddit_subs_used = 0
    for sub in ("NHLHUT", "EASHL", "NHL25", "nhl"):
        if not budget.can_reddit():
            break
        if reddit_subs_used >= 2:
            break
        try:
            remaining = max(0, MAX_REDDIT - budget.reddit)
            if remaining <= 0:
                break
            threads = adapter.reddit_threads(budget, sub, limit=min(3, remaining))
            sources_checked.append(f"reddit:r/{sub}:{len(threads)}")
            findings.extend(_extract_reddit_findings(threads, game_title))
            reddit_subs_used += 1
        except RuntimeError as e:
            notes.append(str(e))
            break
        except Exception as e:
            notes.append(f"reddit_error:{type(e).__name__}")
            incomplete = True
            if budget.can_retry():
                budget.record_retry()

    # --- Creators (optional, limited) ---
    if budget.can_search("creator_patch") or budget.creators < MAX_CREATORS:
        # creator_items may call search internally on live adapter
        try:
            if budget.can_creator():
                creators = adapter.creator_items(budget, f"{game_title} patch notes breakdown", limit=MAX_CREATORS)
                sources_checked.append(f"creators:{len(creators)}")
                findings.extend(
                    _extract_community_findings(creators, game_title, default_conf="medium", source_type="competitive")
                )
        except RuntimeError as e:
            notes.append(str(e))
        except Exception as e:
            notes.append(f"creator_error:{type(e).__name__}")

    # Deduplicate findings by claim fingerprint
    findings = _dedupe_findings(findings)

    # Reject unsupported future title speculation
    cleaned: list[Finding] = []
    for f in findings:
        if _is_speculative_future_title(f.claim):
            notes.append(f"rejected_speculation:{f.finding_id}")
            continue
        cleaned.append(f)
    findings = cleaned

    # Detect conflicts (same topic opposite claims)
    conflicts = _detect_conflicts(findings)
    if conflicts:
        for c in conflicts:
            notes.append(f"conflict:{c}")

    # Expire stale candidates from prior meta files (mark only)
    expired_n = _expire_stale_markers(vault, write=write_files)

    # Internal learning
    internal = review_internal(vault, jobs_dir, game_title)
    findings.extend(internal)

    # Single synthesis "call" (local deterministic synthesis — counts as 1)
    budget.record_synthesis()
    synthesis = _synthesize(findings, conflicts, game_title)
    notes.extend(synthesis.get("notes") or [])

    # Knowledge writes
    files_written: list[str] = []
    proposals: list[dict] = []
    knowledge_updated = False

    if write_files:
        # Always write daily record
        pass

    # Auto-update safe records
    for f in findings:
        if f.source_type == "official" and f.confidence == "official":
            if write_files:
                p = _apply_official_update(vault, f, active)
                if p:
                    files_written.extend(p)
                    knowledge_updated = True
        elif f.status == "corroborated" and f.confidence in ("high", "official"):
            if write_files:
                p = _append_meta_candidate(vault, f, approved=False)
                if p:
                    files_written.append(p)
                    knowledge_updated = True
        elif f.source_type == "community":
            # stay candidate only
            if write_files:
                p = _append_meta_candidate(vault, f, approved=False)
                if p:
                    files_written.append(p)
                    # candidate notes count as knowledge update only if new file lines — track lightly
                    knowledge_updated = knowledge_updated or False

    # Production-impacting proposal (max 1)
    for f in findings:
        if f.production_impact and f.confidence in ("high", "official") and budget.can_proposal():
            if any(a in f.topic for a in ("rubric", "prompt", "schema", "weights")) or f.production_impact:
                if write_files:
                    budget.record_proposal()
                    prop = ensure_proposal(
                        vault,
                        change=f"Review coaching guidance for: {f.claim[:120]}",
                        evidence=f.evidence_summary,
                        game_mode=f"{game_title}/{f.game_mode}",
                        confidence=f.confidence,
                        prior="current approved meta / defaults",
                        proposed="mode-specific guidance update pending Bryan approval",
                        risks="overfitting to transient meta; mode bleed",
                    )
                    if prop:
                        proposals.append(prop)
                        files_written.append("learning/proposed-changes.md")
                else:
                    proposals.append({"id": "dry-run", "change": f.claim[:120], "status": "pending_bryan_review"})
                    budget.record_proposal()
                break

    # Never touch protected rubric path
    notes.append("protected:rubric_untouched")
    notes.append("protected:production_prompt_untouched")

    # Outcome selection
    would_update = any(f.source_type == "official" and f.confidence == "official" for f in findings)
    if incomplete and not findings:
        outcome = "RESEARCH_INCOMPLETE"
    elif conflicts and any("material" in c for c in conflicts):
        outcome = "SOURCE_CONFLICT"
    elif proposals:
        outcome = "REVIEW_REQUIRED"
    elif knowledge_updated or would_update:
        # dry-run with official hits still reports KNOWLEDGE_UPDATED (would-write)
        if any(f.topic == "title" and "27" in f.claim for f in findings) or any(
            f.notify and f.topic == "title" for f in findings
        ):
            outcome = "REVIEW_REQUIRED" if not write_files else (
                "REVIEW_REQUIRED" if proposals else "KNOWLEDGE_UPDATED"
            )
            # new title announce always needs human awareness
            if any(f.topic == "title" and "27" in (f.claim + f.game_title) for f in findings):
                outcome = "REVIEW_REQUIRED"
        else:
            outcome = "KNOWLEDGE_UPDATED"
    elif not findings or all(f.status == "candidate" and f.confidence in ("low", "unverified") for f in findings):
        outcome = "NO_MEANINGFUL_CHANGE"
    else:
        if knowledge_updated:
            outcome = "KNOWLEDGE_UPDATED"
        elif incomplete:
            outcome = "RESEARCH_INCOMPLETE"
        else:
            outcome = "NO_MEANINGFUL_CHANGE"

    # dry-run: simulate would-write paths
    would_write = []
    if dry_run or not write_files:
        would_write.append(f"daily-research/{force_date or day_stamp()}.md")
        for f in findings:
            if f.source_type == "official":
                would_write.append("current-game.md|release-history.md|games/*/patches.md")
                break
        if proposals:
            would_write.append("learning/proposed-changes.md")

    # Daily report (write even on dry-run to state_dir only if not write_files)
    date_s = force_date or day_stamp()
    report_body = _format_daily_report(
        date_s=date_s,
        active_game=game_title,
        sources_checked=sources_checked,
        findings=findings,
        conflicts=conflicts,
        proposals=proposals,
        budget=budget.snapshot(),
        outcome=outcome,
        notes=notes,
        expired_n=expired_n,
        dry_run=bool(dry_run or not write_files),
    )
    daily_path = ""
    if write_files:
        daily_path = str(_write_daily(vault, date_s, report_body))
        files_written.append(daily_path)
    else:
        state_dir.mkdir(parents=True, exist_ok=True)
        p = state_dir / f"dry-run-{date_s}.md"
        p.write_text(report_body, encoding="utf-8")
        daily_path = str(p)

    # Runtime context sample (no inject disputed)
    ctx = build_runtime_context(vault, game_mode="eashl")
    notes.append(f"runtime_context_chars={ctx['chars']}")

    # Notifications
    notify, reason = should_notify(findings, outcome, proposals)
    production_affected = bool(proposals) or any(f.production_impact and f.status == "approved" for f in findings)
    approval_required = bool(proposals) or outcome == "REVIEW_REQUIRED"
    notif = None
    if notify:
        msg = format_slack_message(
            outcome=outcome,
            reason=reason,
            findings=findings,
            active_game=game_title,
            production_affected=production_affected,
            approval_required=approval_required,
        )
        notif = emit_notification(state_dir, msg, enabled=True)
    else:
        notif = emit_notification(
            state_dir,
            f"suppressed no-change ({outcome})",
            enabled=False,
        )

    # Persist last run json
    state_dir.mkdir(parents=True, exist_ok=True)
    result = LoopResult(
        outcome=outcome,
        active_game=game_title,
        findings=findings,
        sources_checked=sources_checked,
        budget=budget.snapshot(),
        proposals=proposals,
        files_written=files_written + (would_write if not write_files else []),
        notification=notif,
        daily_path=daily_path,
        dry_run=bool(dry_run or not write_files),
        notes=notes,
        estimated_tokens=_estimate_tokens(budget.snapshot(), findings),
    )
    (state_dir / "last_run.json").write_text(
        json.dumps(result.to_dict(), indent=2, default=str), encoding="utf-8"
    )
    return result


def _estimate_tokens(budget: dict, findings: list[Finding]) -> int:
    # rough: pages*800 + searches*200 + synthesis 1500 + findings*100
    return (
        int(budget.get("pages") or 0) * 800
        + int(budget.get("web_searches") or 0) * 200
        + int(budget.get("reddit") or 0) * 400
        + int(budget.get("creators") or 0) * 300
        + int(budget.get("synthesis_calls") or 0) * 1500
        + len(findings) * 100
        + 500
    )


def _read_active_game(vault: Path) -> dict[str, str]:
    text = (vault / "current-game.md").read_text(encoding="utf-8") if (vault / "current-game.md").is_file() else ""
    title = "NHL 26"
    slug = "nhl-26"
    m = re.search(r"\|\s*Title\s*\|\s*([^|]+)\|", text)
    if m:
        title = m.group(1).strip()
    m = re.search(r"\|\s*Slug\s*\|\s*`?([^|`]+)`?\s*\|", text)
    if m:
        slug = m.group(1).strip()
    return {"title": title, "slug": slug, "raw": text}


def _extract_official_findings(docs: list[SourceDoc], game_title: str) -> list[Finding]:
    out: list[Finding] = []
    for d in docs:
        if d.tier != 1 and d.source_type != "official":
            continue
        text = d.safe_text()
        # patch
        if re.search(r"patch notes|title update|tuner", text, re.I):
            claim = _first_sentence(text) or d.title or "Official patch/update mentioned"
            out.append(
                Finding(
                    finding_id=finding_id(claim, d.url, game_title),
                    game_title=game_title,
                    game_version_or_patch=_guess_version(text),
                    game_mode="all",
                    topic="official_patch",
                    claim=claim[:300],
                    source_type="official",
                    source=d.url or d.title,
                    publication_date=d.published or utc_iso()[:10],
                    date_discovered=utc_iso()[:10],
                    evidence_summary=text[:400],
                    confidence="official",
                    status="corroborated",
                    recheck_date=default_recheck("official", "official", "patch"),
                    tier=1,
                    notify=True,
                    production_impact=False,
                )
            )
        # release / title
        if re.search(r"announc\w+ .*nhl\s*2[0-9]|nhl\s*2[0-9].*announc|reveal trailer|watch the nhl\s*2[0-9] reveal", text, re.I):
            claim = _first_sentence(text) or d.title
            if not _is_speculative_future_title(claim):
                out.append(
                    Finding(
                        finding_id=finding_id(claim, d.url, game_title),
                        game_title=game_title,
                        game_version_or_patch="n/a",
                        game_mode="all",
                        topic="title",
                        claim=claim[:300],
                        source_type="official",
                        source=d.url or d.title,
                        publication_date=d.published or utc_iso()[:10],
                        date_discovered=utc_iso()[:10],
                        evidence_summary=text[:400],
                        confidence="official",
                        status="corroborated",
                        recheck_date=default_recheck("official", "official", "release"),
                        tier=1,
                        notify=True,
                    )
                )
        if re.search(r"\bout now\b|releases?\s+(on|this)|release date|pre-?order", text, re.I):
            claim = _first_sentence(text) or f"Release/availability info: {d.title}"
            out.append(
                Finding(
                    finding_id=finding_id(claim, d.url, "release"),
                    game_title=game_title,
                    game_version_or_patch="n/a",
                    game_mode="all",
                    topic="release",
                    claim=claim[:300],
                    source_type="official",
                    source=d.url or d.title,
                    publication_date=d.published or utc_iso()[:10],
                    date_discovered=utc_iso()[:10],
                    evidence_summary=text[:400],
                    confidence="official",
                    status="corroborated",
                    recheck_date=default_recheck("official", "official", "release"),
                    tier=1,
                    notify=True,
                )
            )
        # Active title signal: OUT NOW on product page
        if re.search(r"nhl\s*26\s*out now|nhl®?\s*26.*out now", text, re.I):
            out.append(
                Finding(
                    finding_id=finding_id("NHL 26 OUT NOW", d.url, game_title),
                    game_title="NHL 26",
                    game_version_or_patch="n/a",
                    game_mode="all",
                    topic="release",
                    claim="Official EA page indicates NHL 26 is OUT NOW",
                    source_type="official",
                    source=d.url or d.title,
                    publication_date=d.published or utc_iso()[:10],
                    date_discovered=utc_iso()[:10],
                    evidence_summary=text[:400],
                    confidence="official",
                    status="corroborated",
                    recheck_date=default_recheck("official", "official", "release"),
                    tier=1,
                    notify=False,
                )
            )
        if re.search(r"nhl\s*27\s*reveal|reveal trailer.*nhl\s*27|nhl\s*27 reveal", text, re.I):
            out.append(
                Finding(
                    finding_id=finding_id("NHL 27 reveal", d.url, "announce"),
                    game_title="NHL 27",
                    game_version_or_patch="n/a",
                    game_mode="all",
                    topic="title",
                    claim="Official EA NHL hub references NHL 27 reveal trailer",
                    source_type="official",
                    source=d.url or d.title,
                    publication_date=d.published or utc_iso()[:10],
                    date_discovered=utc_iso()[:10],
                    evidence_summary=text[:400],
                    confidence="official",
                    status="corroborated",
                    recheck_date=default_recheck("official", "official", "release"),
                    tier=1,
                    notify=True,
                )
            )
    return out


def _extract_reddit_findings(docs: list[SourceDoc], game_title: str) -> list[Finding]:
    out = []
    for d in docs:
        claim = d.title or _first_sentence(d.snippet) or "community discussion"
        conf = "low"
        score = (d.meta or {}).get("score") or 0
        try:
            score = int(score)
        except Exception:
            score = 0
        if score >= 100 or (d.meta or {}).get("num_comments", 0) and int(d.meta.get("num_comments") or 0) >= 40:
            conf = "medium"
        conf = community_ceiling(conf)
        mode = _guess_mode(claim + " " + d.snippet)
        out.append(
            Finding(
                finding_id=finding_id(claim, d.url, game_title),
                game_title=game_title,
                game_version_or_patch="unknown",
                game_mode=mode,
                topic=_guess_topic(claim + " " + d.snippet),
                claim=claim[:300],
                source_type="community",
                source=d.url or "reddit",
                publication_date=str(d.published or utc_iso()[:10])[:10],
                date_discovered=utc_iso()[:10],
                evidence_summary=scrub_untrusted_text(
                    f"subreddit={d.meta.get('subreddit')}; score={score}; "
                    f"comments={d.meta.get('num_comments')}; {d.snippet[:280]}"
                ),
                confidence=conf,
                status="candidate",
                recheck_date=default_recheck(conf, "community", "meta"),
                tier=3,
                engagement=f"score={score}",
                subreddit=str(d.meta.get("subreddit") or ""),
            )
        )
    return out


def _extract_community_findings(
    docs: list[SourceDoc],
    game_title: str,
    *,
    default_conf: str,
    source_type: str,
) -> list[Finding]:
    out = []
    for d in docs:
        claim = d.title or _first_sentence(d.snippet) or "strategy note"
        conf = default_conf if d.tier <= 2 else community_ceiling(default_conf)
        status = "candidate"
        # two+ competitive docs same claim handled later in corroboration
        out.append(
            Finding(
                finding_id=finding_id(claim, d.url, game_title),
                game_title=game_title,
                game_version_or_patch="unknown",
                game_mode=_guess_mode(claim),
                topic=_guess_topic(claim + " " + d.snippet),
                claim=claim[:300],
                source_type=source_type if source_type != "competitive" else (
                    "competitive" if d.source_type in ("competitive", "creator", "official") else "community"
                ),
                source=d.url or d.title,
                publication_date=d.published or utc_iso()[:10],
                date_discovered=utc_iso()[:10],
                evidence_summary=d.safe_text()[:400],
                confidence=conf,
                status=status,
                recheck_date=default_recheck(conf, source_type, "meta"),
                tier=d.tier,
            )
        )
    return _corroborate(out)


def _corroborate(findings: list[Finding]) -> list[Finding]:
    """If ≥2 independent competitive/official sources share key tokens, bump status."""
    by_topic: dict[str, list[Finding]] = {}
    for f in findings:
        by_topic.setdefault(f.topic + ":" + f.game_mode, []).append(f)
    for group in by_topic.values():
        high_tier = [f for f in group if f.tier <= 2 or f.source_type in ("competitive", "official")]
        if len(high_tier) >= 2:
            # check token overlap on claims
            for f in high_tier:
                others = [g for g in high_tier if g.finding_id != f.finding_id]
                if any(_claim_overlap(f.claim, g.claim) >= 0.3 for g in others):
                    if f.confidence in ("medium", "high") and f.status == "candidate":
                        f.status = "corroborated"
                        if f.confidence == "medium":
                            f.confidence = "high"
    return findings


def _claim_overlap(a: str, b: str) -> float:
    ta = set(re.findall(r"[a-z0-9]+", a.lower()))
    tb = set(re.findall(r"[a-z0-9]+", b.lower()))
    if not ta or not tb:
        return 0.0
    return len(ta & tb) / max(1, len(ta | tb))


def _dedupe_findings(findings: list[Finding]) -> list[Finding]:
    seen = set()
    out = []
    for f in findings:
        key = re.sub(r"\W+", "", f.claim.lower())[:80]
        if key in seen:
            continue
        seen.add(key)
        out.append(f)
    return out


def _detect_conflicts(findings: list[Finding]) -> list[str]:
    conflicts = []
    pos_re = re.compile(r"\b(op|broken|overpowered|too strong)\b", re.I)
    neg_re = re.compile(r"\b(nerf\w*|dead|useless|patched|unviable)\b", re.I)
    by_topic: dict[str, list[Finding]] = {}
    for f in findings:
        key = f.topic if f.topic != "general_meta" else _guess_topic(f.claim)
        by_topic.setdefault(key, []).append(f)
    # also global scan for polarity pairs with claim overlap
    for i, a in enumerate(findings):
        for b in findings[i + 1 :]:
            if _claim_overlap(a.claim, b.claim) < 0.15:
                continue
            a_pos, a_neg = bool(pos_re.search(a.claim)), bool(neg_re.search(a.claim))
            b_pos, b_neg = bool(pos_re.search(b.claim)), bool(neg_re.search(b.claim))
            if (a_pos and b_neg) or (a_neg and b_pos):
                topic = a.topic or "general_meta"
                conflicts.append(f"material:{topic}")
                for g in (a, b):
                    if g.confidence != "official":
                        g.status = "disputed"
                        g.contradiction_notes = "conflicting polarity on overlapping claims"
    for topic, group in by_topic.items():
        if len(group) < 2:
            continue
        claims = " || ".join(g.claim for g in group)
        if pos_re.search(claims) and neg_re.search(claims):
            tag = f"material:{topic}"
            if tag not in conflicts:
                conflicts.append(tag)
            for g in group:
                if g.confidence != "official" and g.status != "disputed":
                    g.status = "disputed"
                    g.contradiction_notes = "conflicting claims in same topic"
    return conflicts


def _is_speculative_future_title(claim: str) -> bool:
    low = claim.lower()
    if re.search(r"nhl\s*2[89]|nhl\s*30", low):
        if not re.search(r"official|ea announces|ea announced|revealed by ea", low):
            return True
    if "i hope" in low or "should be called" in low or "leak says" in low:
        if "nhl" in low:
            return True
    return False


def _guess_version(text: str) -> str:
    m = re.search(r"(title update\s*\d+|tu\s*\d+|patch\s*[\d.]+)", text, re.I)
    return m.group(1) if m else "unspecified"


def _guess_mode(text: str) -> str:
    low = text.lower()
    if "eashl" in low or "club" in low:
        return "eashl"
    if "hut" in low:
        return "hut"
    if "versus" in low or "online vs" in low:
        return "online_versus"
    if "franchise" in low:
        return "franchise"
    if "be a pro" in low or "bap" in low:
        return "be_a_pro"
    return "unspecified"


def _guess_topic(text: str) -> str:
    low = text.lower()
    for k in (
        "goalie",
        "defense",
        "offensive",
        "offense",
        "one-timer",
        "cross crease",
        "poke check",
        "skating",
        "patch",
        "exploit",
        "glitch",
        "transition",
        "power play",
        "penalty kill",
    ):
        if k in low:
            return k.replace(" ", "_")
    return "general_meta"


def _first_sentence(text: str) -> str:
    text = scrub_untrusted_text(text, 500)
    parts = re.split(r"(?<=[.!?])\s+", text.strip())
    return parts[0][:300] if parts else ""


def _synthesize(findings: list[Finding], conflicts: list[str], game_title: str) -> dict:
    notes = [f"synthesis_findings={len(findings)}", f"active_game={game_title}"]
    if conflicts:
        notes.append("synthesis:conflicts_present")
    official = sum(1 for f in findings if f.source_type == "official")
    notes.append(f"official_findings={official}")
    return {"notes": notes}


def _apply_official_update(vault: Path, f: Finding, active: dict) -> list[str]:
    written = []
    if f.topic in ("release", "title"):
        # append to release-history notes section
        rh = vault / "release-history.md"
        if rh.is_file():
            with rh.open("a", encoding="utf-8") as fh:
                fh.write(f"\n- {utc_iso()[:10]} official: {f.claim[:200]} ({f.source})\n")
            written.append(str(rh))
        cg = vault / "current-game.md"
        if cg.is_file() and f.topic == "title":
            with cg.open("a", encoding="utf-8") as fh:
                fh.write(f"\n## Verification log\n\n- {utc_iso()}: {f.claim[:200]}\n")
            written.append(str(cg))
    if f.topic == "official_patch":
        slug = active.get("slug") or "nhl-26"
        pp = vault / "games" / slug / "patches.md"
        pp.parent.mkdir(parents=True, exist_ok=True)
        with pp.open("a", encoding="utf-8") as fh:
            fh.write(
                f"| {utc_iso()[:10]} | {f.game_version_or_patch} | {f.claim[:120]} | {f.source[:80]} | yes |\n"
            )
        written.append(str(pp))
    return written


def _append_meta_candidate(vault: Path, f: Finding, approved: bool) -> str | None:
    area = {
        "goalie": "goalie.md",
        "defense": "defense.md",
        "offense": "offense.md",
        "offensive": "offense.md",
        "transition": "transition.md",
        "exploit": "exploits-and-counters.md",
        "glitch": "exploits-and-counters.md",
    }.get(f.topic, None)
    if f.game_mode == "eashl":
        area = "eashl.md"
    elif f.game_mode == "hut":
        area = "hut.md"
    elif f.game_mode == "online_versus":
        area = "online-versus.md"
    if not area:
        area = "offense.md" if "offens" in f.topic else "defense.md" if "defens" in f.topic else "current-meta.md"
        if area == "current-meta.md":
            path = vault / "meta" / area
        else:
            path = vault / "meta" / area
    else:
        path = vault / "meta" / area
    path.parent.mkdir(parents=True, exist_ok=True)
    status = "approved" if approved else f.status
    # never write abuse how-to
    if f.topic in ("exploit", "glitch") and re.search(r"how to|step by step|perform the", f.claim, re.I):
        claim = "Exploit pattern noted for defensive recognition only (details withheld)."
    else:
        claim = f.claim.replace("|", "/")
    line = (
        f"| {f.finding_id} | {claim[:100]} | {f.game_mode} | {f.confidence} | {status} | {f.recheck_date} |\n"
    )
    existing = path.read_text(encoding="utf-8") if path.exists() else ""
    if f.finding_id in existing:
        return None
    with path.open("a", encoding="utf-8") as fh:
        fh.write(line)
    return str(path)


def _expire_stale_markers(vault: Path, write: bool) -> int:
    n = 0
    meta = vault / "meta"
    if not meta.is_dir():
        return 0
    today = day_stamp()
    for fp in meta.glob("*.md"):
        text = fp.read_text(encoding="utf-8")
        lines = text.splitlines()
        new_lines = []
        changed = False
        for ln in lines:
            m = re.search(r"\|\s*(F-[a-f0-9]+)\s*\|.*\|\s*(\d{4}-\d{2}-\d{2})\s*\|", ln)
            if m and is_expired(m.group(2), today) and "obsolete" not in ln.lower():
                ln = ln.replace("| candidate |", "| obsolete |").replace("| corroborated |", "| obsolete |")
                changed = True
                n += 1
            new_lines.append(ln)
        if changed and write:
            fp.write_text("\n".join(new_lines) + "\n", encoding="utf-8")
    return n


def _write_daily(vault: Path, date_s: str, body: str) -> Path:
    ddir = vault / "daily-research"
    ddir.mkdir(parents=True, exist_ok=True)
    path = ddir / f"{date_s}.md"
    path.write_text(body, encoding="utf-8")
    return path


def _format_daily_report(
    *,
    date_s: str,
    active_game: str,
    sources_checked: list[str],
    findings: list[Finding],
    conflicts: list[str],
    proposals: list[dict],
    budget: dict,
    outcome: str,
    notes: list[str],
    expired_n: int,
    dry_run: bool,
) -> str:
    if outcome == "NO_MEANINGFUL_CHANGE" and not findings:
        return f"""# Daily Research {date_s}

- **execution:** {utc_iso()}
- **active game:** {active_game}
- **outcome:** `NO_MEANINGFUL_CHANGE`
- **dry_run:** {dry_run}
- **sources checked:** {len(sources_checked)}
- **budget:** searches={budget.get('web_searches')} pages={budget.get('pages')} reddit={budget.get('reddit')} creators={budget.get('creators')} synthesis={budget.get('synthesis_calls')}
- **notes:** no material official or corroborated changes

Short no-change record. Stop.
"""
    lines = [
        f"# Daily Research {date_s}",
        "",
        f"- **execution:** {utc_iso()}",
        f"- **active game:** {active_game}",
        f"- **outcome:** `{outcome}`",
        f"- **dry_run:** {dry_run}",
        f"- **sources checked:** {', '.join(sources_checked) or 'none'}",
        f"- **budget:** `{json.dumps(budget)}`",
        f"- **expired markers:** {expired_n}",
        f"- **proposals:** {len(proposals)}",
        "",
        "## Official updates",
    ]
    off = [f for f in findings if f.source_type == "official"]
    if not off:
        lines.append("- none")
    for f in off:
        lines.append(f"- [{f.confidence}] {f.claim} — {f.source}")
    lines += ["", "## Community / competitive trends"]
    comm = [f for f in findings if f.source_type != "official"]
    if not comm:
        lines.append("- none")
    for f in comm[:15]:
        lines.append(
            f"- `{f.status}`/{f.confidence} [{f.game_mode}] {f.claim} ({f.source_type})"
        )
    lines += ["", "## Candidate meta changes"]
    cands = [f for f in findings if f.status in ("candidate", "corroborated")]
    if not cands:
        lines.append("- none")
    for f in cands[:10]:
        lines.append(f"- {f.finding_id}: {f.claim}")
    lines += ["", "## Contradictions"]
    lines += [f"- {c}" for c in conflicts] if conflicts else ["- none"]
    lines += ["", "## Internal learning", "- bounded job/feedback/journal scan complete"]
    lines += ["", "## Proposals requiring approval"]
    if not proposals:
        lines.append("- none")
    for p in proposals:
        lines.append(f"- {p}")
    lines += ["", "## Notes"]
    for n in notes:
        lines.append(f"- {n}")
    lines += ["", f"## Final outcome\n\n`{outcome}`", ""]
    return "\n".join(lines)
