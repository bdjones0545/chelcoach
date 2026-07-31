import type {
  BoundingBox,
  EvidenceConfidenceLabel,
  PlayerIdentificationProvider,
  PlayerIdentificationStatus,
  PlayerPosition,
  ScottyErrorCode,
  TeamSide,
} from "../scottyContract";

export interface ConfirmationFrameRecord {
  frameId: string;
  uploadId: string;
  ownerId: string;
  identificationId: string;
  storageObjectKey: string;
  timestampSec: number;
  mimeType: "image/jpeg" | "image/webp";
  width: number;
  height: number;
  byteSize: number;
  expiresAt: string;
  deletedAt?: string;
  createdAt: string;
}

export interface PlayerCandidateRecord {
  candidateId: string;
  uploadId: string;
  identificationId: string;
  representativeFrameId: string;
  timestampSec: number;
  boundingBox: BoundingBox;
  position?: PlayerPosition;
  jerseyNumber?: number | null;
  indicatorColor?: string | null;
  teamSide?: TeamSide;
  confidence: number;
  evidenceSummary: string;
  displayLabel: string;
  expiresAt: string;
  createdAt: string;
}

export interface PlayerIdentificationRecord {
  identificationId: string;
  uploadId: string;
  ownerId: string;
  analysisJobId?: string;
  contractVersion: string;
  status: PlayerIdentificationStatus;
  detected: boolean;
  confidence: number;
  confidenceLabel: EvidenceConfidenceLabel;
  predictedPosition: PlayerPosition;
  predictedJerseyNumber: number | null;
  predictedIndicatorColor: string | null;
  predictedTeamSide: TeamSide;
  evidenceTimestampsSec: number[];
  uncertainties: string[];
  userConfirmed: boolean;
  confirmationId?: string;
  provider: PlayerIdentificationProvider;
  fixtureScenario?: string;
  /** Original prediction preserved after user confirmation/correction. */
  originalPrediction?: {
    position: PlayerPosition;
    jerseyNumber: number | null;
    indicatorColor: string | null;
    teamSide: TeamSide;
    confidence: number;
    candidateId?: string;
  };
  additionalExtractionAttempts: number;
  contextCorrection?: {
    jerseyNumber?: number;
    indicatorColor?: string;
    position?: PlayerPosition;
    teamSide?: TeamSide;
    correctedAt: string;
  };
  errorCode?: ScottyErrorCode;
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
}

export interface PlayerConfirmationRecord {
  confirmationId: string;
  identificationId: string;
  uploadId: string;
  ownerId: string;
  selectedCandidateId: string;
  selectedFrameId: string;
  confirmedPosition?: PlayerPosition;
  confirmedJerseyNumber?: number;
  confirmedIndicatorColor?: string;
  confirmedTeamSide?: TeamSide;
  originalPredictedCandidateId?: string;
  originalConfidence: number;
  confirmedAt: string;
  source: "user";
  createdAt: string;
}

export interface ProcessingLeaseRecord {
  leaseId: string;
  uploadId: string;
  analysisJobId: string;
  acquiredAt: string;
  heartbeatAt: string;
  expiresAt: string;
  releasedAt?: string;
  status: "active" | "released" | "expired" | "revoked";
}
