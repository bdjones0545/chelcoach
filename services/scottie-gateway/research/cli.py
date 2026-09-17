#!/usr/bin/env python3
"""CLI entry for Scottie daily NHL research loop."""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

SERVICES = Path(__file__).resolve().parents[1]
if str(SERVICES) not in sys.path:
    sys.path.insert(0, str(SERVICES))

from research.loop import run_daily_research  # noqa: E402


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="Scottie daily NHL meta research (bounded)")
    p.add_argument(
        "--mode",
        choices=("fixture", "live", "dry-run"),
        default="dry-run",
        help="fixture=tests; dry-run=no vault writes; live=bounded network",
    )
    p.add_argument("--fixture", type=Path, default=None, help="JSON fixture path")
    p.add_argument("--vault", type=Path, default=Path("/root/Desktop/Kevin/Agents/Scottie"))
    p.add_argument("--state-dir", type=Path, default=Path("/root/.hermes/profiles/scottie/state/research"))
    p.add_argument("--write", action="store_true", help="Force write vault artifacts")
    p.add_argument("--no-write", action="store_true", help="Force no vault writes")
    p.add_argument("--json-out", type=Path, default=None)
    p.add_argument("--date", type=str, default=None, help="YYYY-MM-DD override for report name")
    args = p.parse_args(argv)

    write = None
    if args.write:
        write = True
    if args.no_write:
        write = False

    result = run_daily_research(
        vault=args.vault,
        state_dir=args.state_dir,
        mode=args.mode,
        fixture_path=args.fixture,
        write_files=write,
        force_date=args.date,
    )
    summary = {
        "outcome": result.outcome,
        "active_game": result.active_game,
        "findings": len(result.findings),
        "budget": result.budget,
        "proposals": len(result.proposals),
        "daily_path": result.daily_path,
        "dry_run": result.dry_run,
        "estimated_tokens": result.estimated_tokens,
        "notification_skipped": (result.notification or {}).get("skipped"),
        "files_written": result.files_written[:20],
    }
    print(json.dumps(summary, indent=2))
    if args.json_out:
        args.json_out.write_text(json.dumps(result.to_dict(), indent=2, default=str), encoding="utf-8")
    return 0 if result.outcome != "RESEARCH_INCOMPLETE" else 2


if __name__ == "__main__":
    raise SystemExit(main())
