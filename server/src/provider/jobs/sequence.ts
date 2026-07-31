/**
 * Sequence-safe provider status evaluation.
 */
import type { ScottyJobStatusResponse } from "../../scottyContract";
import { isLegalStatusTransition, isTerminalStatus } from "./transitions";
import type { AnalysisJob, ProviderStatusDecision } from "./types";

export function evaluateProviderStatusUpdate(input: {
  currentJob: AnalysisJob;
  incoming: ScottyJobStatusResponse;
}): ProviderStatusDecision {
  const { currentJob, incoming } = input;
  const incomingSeq =
    incoming.sequenceNumber ??
    currentJob.providerSequenceNumber ??
    currentJob.statusSequenceNumber;
  const currentSeq = currentJob.providerSequenceNumber ?? currentJob.statusSequenceNumber;

  if (isTerminalStatus(currentJob.canonicalStatus)) {
    if (
      incoming.status === currentJob.canonicalStatus &&
      incomingSeq === currentSeq &&
      (incoming.reportReady ?? false) === currentJob.reportAvailable
    ) {
      return { decision: "idempotent" };
    }
    if (incomingSeq < currentSeq) return { decision: "stale" };
    return { decision: "reject", reason: "terminal_regression" };
  }

  if (incomingSeq < currentSeq) return { decision: "stale" };

  if (incomingSeq === currentSeq) {
    const sameStatus = incoming.status === (currentJob.providerStatus ?? currentJob.canonicalStatus);
    if (sameStatus) return { decision: "idempotent" };
    return { decision: "conflict", reason: "equal_sequence_status_mismatch" };
  }

  // Higher sequence — completed/report-ready must fetch+persist before marking done.
  if (incoming.status === "completed" || incoming.reportReady) {
    if (
      incoming.status === "completed" &&
      !isLegalStatusTransition(currentJob.canonicalStatus, "completed", {
        reportAvailable: true,
      })
    ) {
      return {
        decision: "reject",
        reason: `illegal_transition:${currentJob.canonicalStatus}->completed`,
      };
    }
    return { decision: "requires_report_fetch", nextSequence: incomingSeq };
  }

  if (
    !isLegalStatusTransition(currentJob.canonicalStatus, incoming.status, {
      reportAvailable: incoming.reportReady,
    })
  ) {
    return {
      decision: "reject",
      reason: `illegal_transition:${currentJob.canonicalStatus}->${incoming.status}`,
    };
  }

  return { decision: "advance", nextSequence: incomingSeq };
}
