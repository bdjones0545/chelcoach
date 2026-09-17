"""Analysis orchestration: identity → provider → quality/attribution gate → finalize."""
from __future__ import annotations

import logging
import os
import time
from pathlib import Path
from typing import Any

from . import PROMPT_VERSION
from .attribution import attempt_attribution_repair, validate_attribution
from .jobs import JobStore
from .player_identity import (
    DEFAULT_IDENTITY_THRESHOLD,
    IDENTITY_ERROR,
    identify_controlled_player,
    meets_threshold,
    validate_identity_result,
)
from .provider import Provider, ProviderResult
from .validator import attempt_repair, validate_report

log = logging.getLogger("scottie.analysis")


class AnalysisService:
    def __init__(
        self,
        store: JobStore,
        provider: Provider,
        vault_dir: Path | None = None,
        tmp_dir: Path | None = None,
        identity_threshold: float | None = None,
    ) -> None:
        self.store = store
        self.provider = provider
        self.vault_dir = vault_dir
        self.tmp_dir = tmp_dir
        self.identity_threshold = float(
            identity_threshold
            if identity_threshold is not None
            else os.environ.get("SCOTTIE_IDENTITY_THRESHOLD") or DEFAULT_IDENTITY_THRESHOLD
        )
        if self.tmp_dir:
            self.tmp_dir.mkdir(parents=True, exist_ok=True)

    def process(self, job_id: str) -> None:
        job = self.store.get(job_id)
        if not job:
            return
        if job.get("cancel_requested"):
            self.store.request_cancel(job_id)
            return

        t0 = time.time()
        self.store.set_stage(job_id, "inspecting_input", 8)
        frame_metas = job.get("frame_metas") or []
        if not frame_metas:
            self._fail(job_id, "invalid_input", "No frames on job", keep_jpeg=False)
            return

        timestamps = [float(f.get("timestamp") or 0.0) for f in frame_metas]
        gameplay_ctx = dict(job.get("gameplay_context") or {})
        metadata = dict(job.get("metadata") or {})

        # Frames already extracted by ChelCoach / request — mark stage truthfully
        self.store.set_stage(job_id, "extracting_frames", 15)

        # --- Controlled-player identification (before any scoring) ---
        self.store.set_stage(job_id, "identifying_controlled_player", 25)
        identity = identify_controlled_player(
            frame_metas=frame_metas,
            gameplay_context=gameplay_ctx,
            metadata=metadata,
            user_confirmation=job.get("user_confirmation"),
            threshold=self.identity_threshold,
            timestamps=timestamps,
        )
        ok_schema, schema_errs, identity_validated = validate_identity_result(identity.to_public_dict())
        if not ok_schema or identity_validated is None:
            self._fail(
                job_id,
                "invalid_identity_schema",
                "Identity result failed schema validation: " + "; ".join(schema_errs[:5]),
                keep_jpeg=True,
            )
            return
        identity = identity_validated

        self.store.set_stage(job_id, "validating_player_identity", 35)
        public_identity = identity.to_public_dict()
        # Never persist banned real-world fields
        self.store.update(job_id, player_identity=public_identity)

        if not meets_threshold(identity, self.identity_threshold):
            # Stop before scoring — no silent team analysis
            self.store.update(
                job_id,
                status="awaiting_player_confirmation",
                stage="awaiting_player_confirmation",
                phase_progress=40,
                error_code=IDENTITY_ERROR,
                error_message=(
                    "Controlled player could not be confirmed with sufficient confidence. "
                    "Confirm indicator color, jersey number, position, team side, or a clear timestamp."
                ),
                # keep jpeg for resume
            )
            self._record_identity_learning(job, identity, reason="below_threshold")
            log.info(
                "identity_unconfirmed job=%s conf=%.2f threshold=%.2f",
                job_id,
                identity.confidence,
                self.identity_threshold,
            )
            return

        if job.get("cancel_requested"):
            self.store.request_cancel(job_id)
            return

        # Runtime meta inject (approved only)
        if self.vault_dir:
            try:
                import sys

                services = Path(__file__).resolve().parents[1]
                if str(services) not in sys.path:
                    sys.path.insert(0, str(services))
                from research.runtime_context import build_runtime_context

                mode = str(
                    gameplay_ctx.get("mode")
                    or gameplay_ctx.get("gameMode")
                    or metadata.get("mode")
                    or identity.game_mode
                    or "general"
                )
                ctx = build_runtime_context(Path(self.vault_dir), game_mode=mode)
                if ctx.get("text"):
                    gameplay_ctx["scottieRuntimeMeta"] = ctx["text"][:3500]
                    gameplay_ctx["scottieGameSlug"] = ctx.get("game_slug")
            except Exception as e:  # noqa: BLE001
                log.warning("runtime_context_skip job=%s err=%s", job_id, type(e).__name__)

        # Bound analysis to controlled player
        gameplay_ctx["controlledPlayer"] = identity.to_attribution_dict()
        gameplay_ctx["attributionRules"] = (
            "Grade ONLY the controlled player. Do not attribute teammate turnovers, "
            "goalie errors, opponent mistakes, or team outcomes without a direct link "
            "to the controlled skater. Include observedAction, attributionReason, "
            "attributionConfidence, coachingCategory on each moment."
        )

        jpeg = self.store.take_jpeg(job_id) or self.store.peek_jpeg(job_id) or []

        self.store.set_stage(job_id, "analyzing_gameplay", 55)
        try:
            result: ProviderResult = self.provider.analyze(
                frames_meta=frame_metas,
                metadata=metadata,
                gameplay_context=gameplay_ctx,
                jpeg_payloads=jpeg,
            )
        except Exception as e:  # noqa: BLE001
            log.warning("provider_error job=%s err=%s", job_id, type(e).__name__)
            self._fail(job_id, "provider_failure", f"Provider error: {type(e).__name__}", keep_jpeg=False)
            return

        usage = {
            "provider": result.provider,
            "model": result.model,
            "input_tokens": result.input_tokens,
            "output_tokens": result.output_tokens,
            "latency_ms": result.latency_ms,
            "retries": result.retries,
            "total_analysis_ms": int((time.time() - t0) * 1000),
            "identity_confidence": identity.confidence,
        }
        self.store.update(job_id, usage=usage, prompt_version=PROMPT_VERSION)

        if not result.ok or not result.report:
            self._fail(job_id, "provider_failure", result.error or "Provider returned no report", keep_jpeg=False)
            self._record_learning(job_id, "provider_failure", result.error or "")
            return

        if job.get("cancel_requested"):
            self.store.request_cancel(job_id)
            self.store.cleanup_jpeg(job_id)
            return

        self.store.set_stage(job_id, "validating_report", 78)
        v = validate_report(
            result.report,
            frame_timestamps=timestamps,
            clip_id=job["clip_id"],
            allow_repair=True,
        )
        if not v.ok:
            repaired = attempt_repair(
                result.report,
                frame_timestamps=timestamps,
                clip_id=job["clip_id"],
                validation=v,
            )
            v2 = validate_report(
                repaired,
                frame_timestamps=timestamps,
                clip_id=job["clip_id"],
                allow_repair=False,
            )
            if not v2.ok:
                self._fail(
                    job_id,
                    "invalid_report",
                    "Quality gate failed after one repair: " + "; ".join(v2.errors[:5]),
                    keep_jpeg=False,
                )
                self._record_learning(job_id, "validation_failure", "; ".join(v2.errors[:8]))
                return
            final_report = v2.report
            self.store.update(job_id, retry_count=(job.get("retry_count") or 0) + 1)
        else:
            final_report = v.report

        # Attribution gate
        attr_ok, attr_errs, attr_report = validate_attribution(
            final_report or {},
            identity,
            frame_timestamps=timestamps,
            threshold=self.identity_threshold,
        )
        if not attr_ok:
            repaired_a = attempt_attribution_repair(attr_report or final_report or {}, identity, attr_errs)
            attr_ok2, attr_errs2, attr_report2 = validate_attribution(
                repaired_a,
                identity,
                frame_timestamps=timestamps,
                threshold=self.identity_threshold,
            )
            if not attr_ok2:
                self._fail(
                    job_id,
                    "attribution_failed",
                    "Attribution quality gate failed after one repair: " + "; ".join(attr_errs2[:5]),
                    keep_jpeg=False,
                )
                self._record_learning(job_id, "attribution_failure", "; ".join(attr_errs2[:8]))
                return
            final_report = attr_report2
            self.store.update(job_id, retry_count=(job.get("retry_count") or 0) + 1)
        else:
            final_report = attr_report

        self.store.set_stage(job_id, "finalizing", 92)
        if final_report and "_repaired" in final_report:
            final_report = {k: v for k, v in final_report.items() if not k.startswith("_")}

        # Ensure playerAttribution present
        if isinstance(final_report, dict):
            final_report["playerAttribution"] = identity.to_attribution_dict()

        # Control intelligence (feature-flagged; verified mappings only)
        if isinstance(final_report, dict):
            try:
                import sys

                services = Path(__file__).resolve().parents[1]
                if str(services) not in sys.path:
                    sys.path.insert(0, str(services))
                from controls.registry import attach_execution_to_report, load_registry
                from controls import CONTROL_GUIDANCE_ENABLED

                player_ctx = {
                    **gameplay_ctx,
                    **(metadata or {}),
                    **(gameplay_ctx.get("playerContext") or metadata.get("playerContext") or {}),
                }
                # clip-level override wins
                if isinstance(job.get("gameplay_context"), dict) and job["gameplay_context"].get("playerContext"):
                    player_ctx = {**player_ctx, **job["gameplay_context"]["playerContext"]}
                game_title = str(
                    player_ctx.get("gameTitle")
                    or metadata.get("gameTitle")
                    or gameplay_ctx.get("gameTitle")
                    or "NHL 26"
                )
                reg = load_registry(
                    vault_dir=Path(self.vault_dir) / "controls" if self.vault_dir else None
                )
                final_report = attach_execution_to_report(
                    final_report,
                    reg=reg,
                    player_context=player_ctx,
                    game_title=game_title,
                    enabled=CONTROL_GUIDANCE_ENABLED,
                )
                # Faceoff intelligence (omit section when no faceoff events)
                try:
                    from faceoffs.engine import attach_faceoff_section

                    final_report = attach_faceoff_section(
                        final_report,
                        gameplay_context=gameplay_ctx,
                        metadata=metadata,
                        frame_metas=frame_metas,
                        game_title=game_title,
                        player_context=player_ctx,
                        control_registry=reg,
                        control_enabled=CONTROL_GUIDANCE_ENABLED,
                    )
                except Exception as e:  # noqa: BLE001
                    log.warning("faceoff_attach_skip job=%s err=%s", job_id, type(e).__name__)
                # Strategy intelligence (flagged; approved+fresh only)
                try:
                    from strategies.registry import attach_strategy_to_report, load_registry as load_strategy_registry
                    from strategies import STRATEGY_GUIDANCE_ENABLED

                    sreg = load_strategy_registry(
                        vault_dir=Path(self.vault_dir) if self.vault_dir else None
                    )
                    final_report = attach_strategy_to_report(
                        final_report,
                        reg=sreg,
                        game_title=game_title,
                        player_context=player_ctx,
                        gameplay_context=gameplay_ctx,
                        identity=public_identity,
                        control_registry=reg,
                        control_enabled=CONTROL_GUIDANCE_ENABLED,
                        enabled=STRATEGY_GUIDANCE_ENABLED,
                    )
                except Exception as e:  # noqa: BLE001
                    log.warning("strategy_attach_skip job=%s err=%s", job_id, type(e).__name__)
            except Exception as e:  # noqa: BLE001
                log.warning("controls_attach_skip job=%s err=%s", job_id, type(e).__name__)
                # Still try faceoffs without controls
                try:
                    import sys

                    services = Path(__file__).resolve().parents[1]
                    if str(services) not in sys.path:
                        sys.path.insert(0, str(services))
                    from faceoffs.engine import attach_faceoff_section

                    player_ctx = {**(gameplay_ctx or {}), **(metadata or {})}
                    game_title = str(
                        player_ctx.get("gameTitle")
                        or metadata.get("gameTitle")
                        or gameplay_ctx.get("gameTitle")
                        or "NHL 26"
                    )
                    final_report = attach_faceoff_section(
                        final_report,
                        gameplay_context=gameplay_ctx,
                        metadata=metadata,
                        frame_metas=frame_metas,
                        game_title=game_title,
                        player_context=player_ctx,
                        control_registry=None,
                        control_enabled=False,
                    )
                except Exception as e2:  # noqa: BLE001
                    log.warning("faceoff_attach_skip job=%s err=%s", job_id, type(e2).__name__)

        self.store.update(
            job_id,
            report=final_report,
            status="completed",
            stage="completed",
            phase_progress=100,
            completed_at=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            error_code=None,
            error_message=None,
            player_identity=public_identity,
        )
        self.store.cleanup_jpeg(job_id)
        self._cleanup_tmp(job_id)
        log.info(
            "job_completed job=%s clip=%s identity_conf=%.2f provider=%s",
            job_id,
            job.get("clip_id"),
            identity.confidence,
            usage.get("provider"),
        )

    def _fail(self, job_id: str, code: str, message: str, *, keep_jpeg: bool = False) -> None:
        self.store.update(
            job_id,
            status="failed",
            stage="failed",
            phase_progress=100,
            error_code=code,
            error_message=message[:400],
            completed_at=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        )
        if not keep_jpeg:
            self.store.cleanup_jpeg(job_id)

    def _cleanup_tmp(self, job_id: str) -> None:
        if not self.tmp_dir:
            return
        for p in self.tmp_dir.glob(f"{job_id}*"):
            try:
                p.unlink()
            except OSError:
                pass

    def _record_learning(self, job_id: str, kind: str, detail: str) -> None:
        if not self.vault_dir:
            return
        path = self.vault_dir / "decision-journal.md"
        try:
            self.vault_dir.mkdir(parents=True, exist_ok=True)
            if not path.exists():
                path.write_text("# Scottie Decision Journal\n\n", encoding="utf-8")
            ts = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
            with path.open("a", encoding="utf-8") as f:
                f.write(f"\n## {ts} — {kind}\n\n- job: `{job_id}`\n- detail: {detail[:500]}\n")
                f.write("- action: recommendation only (no auto production change)\n")
        except OSError:
            log.warning("learning_write_failed job=%s", job_id)

    def _record_identity_learning(self, job: dict[str, Any], identity: Any, *, reason: str) -> None:
        if not self.vault_dir:
            return
        path = self.vault_dir / "learning" / "player-identification-corrections.md"
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            if not path.exists():
                path.write_text(
                    "# Player Identification Corrections\n\n"
                    "No usernames or personal identity. In-game controlled skater only.\n\n",
                    encoding="utf-8",
                )
            ts = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
            pub = identity.to_public_dict() if hasattr(identity, "to_public_dict") else {}
            with path.open("a", encoding="utf-8") as f:
                f.write(f"\n## {ts} — unconfirmed\n\n")
                f.write(f"- clip_id: `{job.get('clip_id')}`\n")
                f.write(f"- job_id: `{job.get('job_id')}`\n")
                f.write(f"- game_mode: {pub.get('gameMode')}\n")
                f.write(f"- predicted_confidence: {pub.get('confidence')}\n")
                f.write(f"- indicator_color: {pub.get('indicatorColor')}\n")
                f.write(f"- jersey_number: {pub.get('jerseyNumber')}\n")
                f.write(f"- reason: {reason}\n")
                f.write(f"- uncertainties: {pub.get('uncertainties')}\n")
                f.write("- user_confirmed_result: pending\n")
                f.write("- proposed_improvement: pending_bryan_review if pattern repeats\n")
        except OSError:
            log.warning("identity_learning_write_failed job=%s", job.get("job_id"))
