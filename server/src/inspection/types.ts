import type { MediaClassification, MediaInspectionStatus, ScottyErrorCode } from "../scottyContract";

export type MediaInspectionJobRecord = {
  id: string;
  uploadId: string;
  ownerId: string;
  storageProvider: string;
  bucketAlias: string;
  objectKey: string;
  objectFingerprint: string;
  contractVersion: string;
  status: MediaInspectionStatus;
  attemptCount: number;
  maxAttempts: number;
  workerId?: string;
  claimedAt?: string;
  claimExpiresAt?: string;
  heartbeatAt?: string;
  startedAt?: string;
  completedAt?: string;
  failedAt?: string;
  nextAttemptAt?: string;
  trustedByteSize?: number;
  trustedMimeType?: string;
  trustedDurationSec?: number;
  videoCodec?: string;
  audioCodec?: string;
  width?: number;
  height?: number;
  frameRate?: number;
  rotation?: number;
  mediaClassification?: MediaClassification;
  errorCode?: ScottyErrorCode | string;
  errorMessage?: string;
  retryable: boolean;
  version: number;
  createdAt: string;
  updatedAt: string;
};

export type CreateInspectionJobInput = {
  uploadId: string;
  ownerId: string;
  storageProvider: string;
  bucketAlias: string;
  objectKey: string;
  objectFingerprint: string;
  trustedByteSize?: number;
  trustedMimeType?: string;
  maxAttempts?: number;
};

export type MediaInspectionWorkerResult = {
  ok: boolean;
  jobId: string;
  uploadId: string;
  status: MediaInspectionStatus;
  errorCode?: string;
};
