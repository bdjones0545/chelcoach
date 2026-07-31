/**
 * Elapsed-time lifecycle derivation — no per-job setTimeout chains.
 */
import type { ScottyErrorCode, ScottyJobStatus } from "../../scottyContract";
import { requiresRemoteConfirmation } from "./scenarios";
import type { SimulatorTimings } from "./timings";
import type { SimulatorDerivedState, SimulatorJob } from "./types";

const STATUS_MESSAGES: Record<ScottyJobStatus, string> = {
  queued: "Queued",
  inspecting_input: "Inspecting gameplay",
  extracting_frames: "Preparing frames",
  identifying_controlled_player: "Confirming your player",
  awaiting_player_confirmation: "Select which player you control",
  validating_player_identity: "Validating player identity",
  analyzing_gameplay: "Analyzing gameplay",
  validating_report: "Validating coaching report",
  finalizing: "Finalizing report",
  completed: "Complete",
  failed: "Analysis failed",
  cancelled: "Cancelled",
};

interface Phase {
  status: ScottyJobStatus;
  durationMs: number;
  sequenceNumber: number;
}

function analyzingDuration(job: SimulatorJob, timings: SimulatorTimings): number {
  const base = timings.analyzingMs;
  if (job.mediaClassification === "full_game" || job.scenario === "slow_full_game") {
    return base * timings.fullGameAnalyzingMultiplier;
  }
  return base;
}

/**
 * Build phase timeline. Confirmation-required jobs pause at awaiting_player_confirmation
 * until confirmationReceivedAt, then resume identity validation onward.
 */
export function buildPhaseTimeline(job: SimulatorJob, timings: SimulatorTimings): Phase[] {
  const phases: Phase[] = [
    { status: "queued", durationMs: timings.queuedMs, sequenceNumber: 1 },
    { status: "inspecting_input", durationMs: timings.inspectingMs, sequenceNumber: 2 },
    { status: "extracting_frames", durationMs: timings.extractingMs, sequenceNumber: 3 },
    { status: "identifying_controlled_player", durationMs: timings.identifyingMs, sequenceNumber: 4 },
  ];

  if (requiresRemoteConfirmation(job.scenario)) {
    phases.push({
      status: "awaiting_player_confirmation",
      durationMs: Number.POSITIVE_INFINITY,
      sequenceNumber: 5,
    });
    phases.push({
      status: "validating_player_identity",
      durationMs: timings.identifyingMs,
      sequenceNumber: 6,
    });
  } else {
    phases.push({
      status: "validating_player_identity",
      durationMs: timings.identifyingMs,
      sequenceNumber: 5,
    });
  }

  const seqBase = requiresRemoteConfirmation(job.scenario) ? 7 : 6;
  phases.push(
    { status: "analyzing_gameplay", durationMs: analyzingDuration(job, timings), sequenceNumber: seqBase },
    { status: "validating_report", durationMs: timings.validatingMs, sequenceNumber: seqBase + 1 },
    { status: "finalizing", durationMs: timings.finalizingMs, sequenceNumber: seqBase + 2 },
    { status: "completed", durationMs: 0, sequenceNumber: seqBase + 3 },
  );
  return phases;
}

function errorForFailurePoint(point: NonNullable<SimulatorJob["failurePoint"]>): {
  code: ScottyErrorCode;
  message: string;
} {
  switch (point) {
    case "inspecting_input":
      return { code: "MEDIA_INSPECTION_FAILED", message: "Simulator inspection failure." };
    case "extracting_frames":
      return { code: "FRAME_EXTRACTION_FAILED", message: "Simulator frame extraction failure." };
    case "identifying_controlled_player":
      return { code: "PLAYER_IDENTIFICATION_FAILED", message: "Simulator player identification failure." };
    case "analyzing_gameplay":
      return { code: "ANALYSIS_FAILED", message: "Simulator analysis failure." };
    case "validating_report":
      return { code: "REPORT_VALIDATION_FAILED", message: "Simulator report validation failure." };
    case "finalizing":
      return { code: "ANALYSIS_TIMEOUT", message: "Simulator timed out while finalizing." };
    case "submission":
      return { code: "PROVIDER_UNAVAILABLE", message: "Simulator submission failure." };
  }
}

export function deriveSimulatorJobState(
  job: SimulatorJob,
  now: Date,
  timings: SimulatorTimings,
): SimulatorDerivedState {
  if (job.cancelledAt || job.terminalStatus === "cancelled") {
    return {
      status: "cancelled",
      sequenceNumber: Math.max(job.lastSequenceNumber, 99),
      enteredAt: job.cancelledAt ?? job.updatedAt,
      pollAfterMs: null,
      userActionRequired: false,
      terminal: true,
      reportReady: false,
      message: STATUS_MESSAGES.cancelled,
      errorCode: "JOB_CANCELLED",
      errorMessage: job.cancelReason ?? "Analysis cancelled.",
    };
  }

  if (job.terminalStatus === "failed" && job.errorCode) {
    return {
      status: "failed",
      sequenceNumber: Math.max(job.lastSequenceNumber, 98),
      enteredAt: job.updatedAt,
      pollAfterMs: null,
      userActionRequired: false,
      terminal: true,
      reportReady: false,
      message: STATUS_MESSAGES.failed,
      errorCode: job.errorCode,
      errorMessage: job.errorMessage,
    };
  }

  if (job.terminalStatus === "completed" && job.report) {
    return {
      status: "completed",
      sequenceNumber: Math.max(job.lastSequenceNumber, 20),
      enteredAt: job.updatedAt,
      pollAfterMs: null,
      userActionRequired: false,
      terminal: true,
      reportReady: true,
      message: STATUS_MESSAGES.completed,
    };
  }

  const acceptedMs = new Date(job.acceptedAt).getTime();
  const nowMs = now.getTime();
  if (nowMs - acceptedMs > timings.maxJobAgeMs) {
    return {
      status: "failed",
      sequenceNumber: 97,
      enteredAt: now.toISOString(),
      pollAfterMs: null,
      userActionRequired: false,
      terminal: true,
      reportReady: false,
      message: STATUS_MESSAGES.failed,
      errorCode: "ANALYSIS_TIMEOUT",
      errorMessage: "Simulator job exceeded maximum age.",
    };
  }

  if (job.scenario === "stalled_job") {
    return {
      status: "analyzing_gameplay",
      sequenceNumber: 6,
      enteredAt: job.acceptedAt,
      pollAfterMs: timings.pollActiveMs,
      userActionRequired: false,
      terminal: false,
      reportReady: false,
      message: "Analysis is taking longer than usual. Still working.",
    };
  }

  if (job.scenario === "unsupported_contract_response") {
    return {
      status: "failed",
      sequenceNumber: 2,
      enteredAt: job.acceptedAt,
      pollAfterMs: null,
      userActionRequired: false,
      terminal: true,
      reportReady: false,
      message: STATUS_MESSAGES.failed,
      errorCode: "UNSUPPORTED_CONTRACT_VERSION",
      errorMessage: "Simulator returned an incompatible contract version.",
    };
  }

  const phases = buildPhaseTimeline(job, timings);
  let cursor = acceptedMs;

  for (const phase of phases) {
    // Pause for remote confirmation.
    if (phase.status === "awaiting_player_confirmation") {
      if (!job.confirmationReceivedAt) {
        return {
          status: "awaiting_player_confirmation",
          sequenceNumber: phase.sequenceNumber,
          enteredAt: new Date(cursor).toISOString(),
          pollAfterMs: null,
          userActionRequired: true,
          terminal: false,
          reportReady: false,
          message: STATUS_MESSAGES.awaiting_player_confirmation,
          errorCode: "PLAYER_IDENTITY_UNCONFIRMED",
          errorMessage: "Confirm which player you controlled before continuing.",
        };
      }
      // Resume timeline from confirmation time.
      cursor = new Date(job.confirmationReceivedAt).getTime();
      continue;
    }

    // Injected failure at phase entry.
    if (job.failurePoint === phase.status) {
      const err = errorForFailurePoint(job.failurePoint);
      return {
        status: "failed",
        sequenceNumber: phase.sequenceNumber,
        enteredAt: new Date(cursor).toISOString(),
        pollAfterMs: null,
        userActionRequired: false,
        terminal: true,
        reportReady: false,
        message: STATUS_MESSAGES.failed,
        errorCode: err.code,
        errorMessage: err.message,
      };
    }

    if (phase.status === "completed") {
      return {
        status: "completed",
        sequenceNumber: phase.sequenceNumber,
        enteredAt: new Date(cursor).toISOString(),
        pollAfterMs: null,
        userActionRequired: false,
        terminal: true,
        reportReady: true,
        message: STATUS_MESSAGES.completed,
      };
    }

    const end = cursor + phase.durationMs;
    if (nowMs < end) {
      return {
        status: phase.status,
        sequenceNumber: phase.sequenceNumber,
        enteredAt: new Date(cursor).toISOString(),
        pollAfterMs: timings.pollActiveMs,
        userActionRequired: false,
        terminal: false,
        reportReady: false,
        message: STATUS_MESSAGES[phase.status],
      };
    }
    cursor = end;
  }

  return {
    status: "completed",
    sequenceNumber: phases[phases.length - 1]!.sequenceNumber,
    enteredAt: new Date(cursor).toISOString(),
    pollAfterMs: null,
    userActionRequired: false,
    terminal: true,
    reportReady: true,
    message: STATUS_MESSAGES.completed,
  };
}
