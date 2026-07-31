/**
 * Canonical status transition policy — no string ordering.
 */
import type { ScottyJobStatus } from "../../scottyContract";

const TERMINAL: ReadonlySet<ScottyJobStatus> = new Set(["completed", "failed", "cancelled"]);

/** Explicit forward edges. Shortcuts must be listed. */
const ALLOWED: ReadonlyMap<ScottyJobStatus, ReadonlySet<ScottyJobStatus>> = new Map([
  [
    "queued",
    new Set([
      "inspecting_input",
      "extracting_frames",
      "identifying_controlled_player",
      "awaiting_player_confirmation",
      "validating_player_identity",
      "analyzing_gameplay",
      "validating_report",
      "finalizing",
      "completed", // allowed only when reportAvailable (enforced below)
      "failed",
      "cancelled",
    ]),
  ],
  [
    "inspecting_input",
    new Set([
      "extracting_frames",
      "identifying_controlled_player",
      "analyzing_gameplay",
      "failed",
      "cancelled",
    ]),
  ],
  [
    "extracting_frames",
    new Set([
      "identifying_controlled_player",
      "awaiting_player_confirmation",
      "validating_player_identity",
      "analyzing_gameplay",
      "failed",
      "cancelled",
    ]),
  ],
  [
    "identifying_controlled_player",
    new Set([
      "awaiting_player_confirmation",
      "validating_player_identity",
      "analyzing_gameplay",
      "failed",
      "cancelled",
    ]),
  ],
  [
    "awaiting_player_confirmation",
    new Set([
      "validating_player_identity",
      "analyzing_gameplay",
      "validating_report",
      "finalizing",
      // Fast local simulator may complete shortly after confirmation within one poll.
      "completed",
      "failed",
      "cancelled",
    ]),
  ],
  [
    "validating_player_identity",
    new Set([
      "analyzing_gameplay",
      "validating_report",
      "finalizing",
      "completed",
      "failed",
      "cancelled",
    ]),
  ],
  [
    "analyzing_gameplay",
    new Set(["validating_report", "finalizing", "completed", "failed", "cancelled"]),
  ],
  ["validating_report", new Set(["finalizing", "completed", "failed", "cancelled"])],
  ["finalizing", new Set(["completed", "failed", "cancelled"])],
  ["completed", new Set()],
  ["failed", new Set()],
  ["cancelled", new Set()],
]);

export function isTerminalStatus(status: ScottyJobStatus): boolean {
  return TERMINAL.has(status);
}

export function isLegalStatusTransition(
  from: ScottyJobStatus,
  to: ScottyJobStatus,
  opts?: { reportAvailable?: boolean },
): boolean {
  if (from === to) return true;
  if (isTerminalStatus(from)) return false;
  const allowed = ALLOWED.get(from);
  if (!allowed || !allowed.has(to)) return false;
  // completed shortcut requires a validated/ready report path (enforced by sync service).
  if (to === "completed" && opts?.reportAvailable !== true) return false;
  return true;
}

export function assertLegalStatusTransition(
  from: ScottyJobStatus,
  to: ScottyJobStatus,
  opts?: { reportAvailable?: boolean },
): void {
  if (!isLegalStatusTransition(from, to, opts)) {
    throw new Error(`ILLEGAL_STATUS_TRANSITION:${from}->${to}`);
  }
}
