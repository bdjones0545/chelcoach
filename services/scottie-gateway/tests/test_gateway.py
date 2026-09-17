"""Gateway unit tests — stdlib only. Run from services/scottie-gateway: python3 -m unittest -v

Each test pins one of the defects found in the 2026-09-17 ground-truth audit so it cannot
silently come back.
"""
from __future__ import annotations

import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from gateway import analysis as analysis_mod  # noqa: E402
from gateway.config import load_config  # noqa: E402
from gateway.validator import attempt_repair, validate_report  # noqa: E402


class HostnameDefault(unittest.TestCase):
    def test_default_public_hostname_is_on_chelcoach_io(self) -> None:
        # chelcoach.com is not ours; the published route is scottie.chelcoach.io.
        with tempfile.TemporaryDirectory() as home:
            env = {k: v for k, v in os.environ.items() if not k.startswith("SCOTTIE_")}
            env["HERMES_SCOTTIE_HOME"] = home
            env["SCOTTIE_TEST_MODE"] = "1"
            saved = dict(os.environ)
            try:
                os.environ.clear()
                os.environ.update(env)
                cfg = load_config(allow_missing_secrets=True)
            finally:
                os.environ.clear()
                os.environ.update(saved)
        self.assertEqual(cfg["hostname_public"], "scottie.chelcoach.io")


class RepairProvenance(unittest.TestCase):
    """attempt_repair() invents content; what it invented must reach the wire as `repair`."""

    def _empty_model_output(self) -> dict:
        # The model returned prose but no scores and no moments — the case the repair path exists for.
        return {
            "biggestStrength": {"title": "Support availability", "detail": "Outlet distance stays playable."},
            "biggestWeakness": {"title": "Strong-side over-commitment", "detail": "Middle ice left light."},
            "filmRoom": {
                "commentary": (
                    "Across the sampled frames the skater keeps a usable outlet on most retrievals "
                    "but drifts to the strong side when the puck moves low, leaving the slot uncovered."
                ),
                "highestImpactAdjustment": {
                    "title": "Hold the middle",
                    "detail": "Stay above the dots one beat longer before chasing strong-side pressure.",
                },
            },
            "confidence": 0.4,
        }

    def test_repair_marks_synthesized_sections_and_survives_validate(self) -> None:
        ts = [4.0, 20.0, 36.0]
        v = validate_report(self._empty_model_output(), frame_timestamps=ts, clip_id="clip", allow_repair=True)
        self.assertFalse(v.ok, "an output with no metrics and no moments must not validate as-is")

        repaired = attempt_repair(self._empty_model_output(), frame_timestamps=ts, clip_id="clip", validation=v)
        self.assertNotIn("_repaired", repaired, "underscore markers never reached the wire; do not reintroduce them")
        self.assertTrue(repaired["repair"]["applied"])
        self.assertIn("metrics", repaired["repair"]["synthesized"])
        self.assertIn("coachingMoments", repaired["repair"]["synthesized"])

        v2 = validate_report(repaired, frame_timestamps=ts, clip_id="clip", allow_repair=False)
        self.assertTrue(v2.ok, v2.errors)
        assert v2.report is not None
        self.assertEqual(v2.report["repair"]["applied"], True)
        self.assertIn("metrics", v2.report["repair"]["synthesized"])
        self.assertIn("coachingMoments", v2.report["repair"]["synthesized"])
        # and the flat 55-everywhere rubric is exactly what was synthesized
        values = {m["value"] for m in v2.report["scorecard"]["metrics"]}
        self.assertEqual(values, {55})

    def test_model_cannot_assert_control_execution(self) -> None:
        """`execution` (and its `verified` flag) is attached only by the controls registry after
        validation. ChelCoach's mapper trusts `execution.verified`; this is what makes that safe."""
        ts = [4.0, 20.0, 36.0]
        raw = {
            **self._empty_model_output(),
            "metrics": {k: 70 for k in ("offensive_positioning", "defensive_positioning", "decision_making", "puck_movement", "spacing", "transition_play")},
            "coachingMoments": [
                {
                    "id": "moment-1",
                    "type": "missed",
                    "title": "Late slot arrival",
                    "timestamp": 20.0,
                    "period": "P1",
                    "teaser": "The weak-side lane opened a beat before the arrival.",
                    "fullBreakdown": (
                        "On the frame near 0:20 the controlled skater is still below the dots while the "
                        "weak-side lane is open; arriving one stride earlier keeps the shooting option alive."
                    ),
                    "evidence": "directly_observable",
                    # a model trying to smuggle a "verified" button mapping through
                    "execution": {"executionAvailable": True, "verified": True, "mechanic": "saucer_pass", "inputs": [{"input": "X", "behavior": "tap"}]},
                }
            ],
        }
        v = validate_report(raw, frame_timestamps=ts, clip_id="clip", allow_repair=True)
        self.assertTrue(v.ok, v.errors)
        assert v.report is not None
        for m in v.report["coachingMoments"]:
            self.assertNotIn("execution", m)
        self.assertNotIn("controlContext", v.report)

    def test_unrepaired_report_carries_no_repair_block(self) -> None:
        ts = [4.0, 20.0, 36.0]
        raw = {
            **self._empty_model_output(),
            "metrics": {
                "offensive_positioning": 71,
                "defensive_positioning": 64,
                "decision_making": 80,
                "puck_movement": 77,
                "spacing": 70,
                "transition_play": 83,
            },
            "coachingMoments": [
                {
                    "id": "moment-1",
                    "type": "missed",
                    "title": "Late slot arrival",
                    "timestamp": 20.0,
                    "period": "P1",
                    "teaser": "The weak-side lane opened a beat before the arrival.",
                    "fullBreakdown": (
                        "On the frame near 0:20 the controlled skater is still below the dots while the "
                        "weak-side lane is open; arriving one stride earlier keeps the shooting option alive."
                    ),
                    "evidence": "directly_observable",
                }
            ],
        }
        v = validate_report(raw, frame_timestamps=ts, clip_id="clip", allow_repair=True)
        self.assertTrue(v.ok, v.errors)
        assert v.report is not None
        self.assertNotIn("repair", v.report)

    def test_a_client_supplied_repair_block_is_not_trusted_unless_applied(self) -> None:
        ts = [4.0]
        raw = {**self._empty_model_output(), "repair": {"applied": False, "synthesized": ["metrics"]}}
        repaired = attempt_repair(raw, frame_timestamps=ts, clip_id="clip",
                                  validation=validate_report(raw, frame_timestamps=ts, clip_id="clip"))
        self.assertTrue(repaired["repair"]["applied"])


class GameTitleResolution(unittest.TestCase):
    def test_title_comes_from_the_request_and_is_never_guessed(self) -> None:
        self.assertEqual(analysis_mod._resolve_game_title("j", {"gameTitle": "NHL 27"}, {}), "NHL 27")
        self.assertEqual(analysis_mod._resolve_game_title("j", {}, {"game_title": " NHL 26 "}), "NHL 26")
        self.assertEqual(analysis_mod._resolve_game_title("j", {}, None, {"gameTitle": ""}), "unspecified")
        self.assertEqual(analysis_mod.UNSPECIFIED_GAME_TITLE, "unspecified")

    def test_no_module_hardcodes_a_game_year(self) -> None:
        offenders = []
        for rel in ("gateway/analysis.py", "controls/registry.py", "faceoffs/engine.py", "strategies/registry.py"):
            text = (ROOT / rel).read_text()
            for i, line in enumerate(text.splitlines(), 1):
                if '"NHL 2' in line and not line.lstrip().startswith("#"):
                    offenders.append(f"{rel}:{i}: {line.strip()}")
        self.assertEqual(offenders, [], "a literal NHL year is a stale default waiting to happen")


class ProviderPrecedence(unittest.TestCase):
    """The profile .env is the single source of truth for SCOTTIE_PROVIDER."""

    def _run(self, env_file: str | None, process_env: dict[str, str]) -> str:
        script = (ROOT / "scripts" / "run_scottie_gateway.sh").read_text()
        # Stop before anything host-specific: no /var/log, no exec of the server.
        script = script.replace("mkdir -p", "true #").replace("exec /usr/bin/python3", "exit 0 #")
        with tempfile.TemporaryDirectory() as home:
            if env_file is not None:
                (Path(home) / ".env").write_text(env_file)
            path = Path(home) / "run.sh"
            path.write_text(script)
            env = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "HOME": home, "HERMES_SCOTTIE_HOME": home, **process_env}
            out = subprocess.run(["bash", str(path)], env=env, capture_output=True, text=True, check=True)
        return out.stdout

    def test_dotenv_wins_over_process_environment(self) -> None:
        out = self._run("SCOTTIE_PROVIDER=xai\n", {"SCOTTIE_PROVIDER": "fake"})
        self.assertIn("provider=xai", out)

    def test_fake_is_only_a_last_resort_default(self) -> None:
        self.assertIn("provider=fake", self._run(None, {}))
        self.assertIn("provider=openai", self._run(None, {"SCOTTIE_PROVIDER": "openai"}))

    def test_supervisord_conf_does_not_pin_the_provider(self) -> None:
        conf = (ROOT / "gateway" / "scottie.supervisord.conf").read_text()
        for line in conf.splitlines():
            if line.startswith("environment="):
                self.assertNotIn("SCOTTIE_PROVIDER", line)


if __name__ == "__main__":
    unittest.main()
