import type {
  EffectivePlayerContext,
  MediaClassification,
  RequestedCapabilities,
  ScottyAnalysisSubmission,
  ScottyErrorCode,
  ScottyJobStatus,
  ScottyReport,
} from "../../scottyContract";
import type { FailurePoint, SimulatorScenario } from "./scenarios";

export interface SimulatorJob {
  externalJobId: string;
  applicationRequestId: string;
  uploadId: string;
  ownerReference: string;
  idempotencyKey: string;
  requestFingerprint: string;
  contractVersion: string;
  scenario: SimulatorScenario;
  acceptedAt: string;
  submission: ScottyAnalysisSubmission;
  effectivePlayer: EffectivePlayerContext;
  capabilities: RequestedCapabilities;
  mediaClassification: MediaClassification;
  mediaDurationSec: number;
  confirmationRequired: boolean;
  confirmationReceivedAt?: string;
  selectedCandidateId?: string;
  cancelledAt?: string;
  cancelReason?: string;
  failurePoint: FailurePoint;
  terminalStatus?: Extract<ScottyJobStatus, "completed" | "failed" | "cancelled">;
  errorCode?: ScottyErrorCode;
  errorMessage?: string;
  report?: ScottyReport;
  lastSequenceNumber: number;
  createdAt: string;
  updatedAt: string;
}

export interface SimulatorDerivedState {
  status: ScottyJobStatus;
  sequenceNumber: number;
  enteredAt: string;
  pollAfterMs: number | null;
  userActionRequired: boolean;
  terminal: boolean;
  reportReady: boolean;
  message: string;
  errorCode?: ScottyErrorCode;
  errorMessage?: string;
}
