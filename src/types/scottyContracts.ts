/**
 * Type-only frontend surface for Scotty shared contracts.
 * Runtime Zod stays out of the client bundle — import types only from shared.
 */
export type {
  ScottyContractVersion,
  SupportedPlatform,
  ControlScheme,
  PlayerPosition,
  GameMode,
  PlayerContext,
  GameContext,
  RawUploadMetadata,
  PublicUploadView,
  ProcessingLease,
  ScottyAnalysisRequest,
  ScottyJobStatusResponse,
  ControlledPlayerIdentification,
  PlayerConfirmationRequest,
  ControlGuidance,
  StrategyAnalysis,
  FaceoffAnalysis,
  PracticeDrill,
  ScottyReport,
  ScottyErrorResponse,
  MediaRetentionPolicy,
  ScottyErrorCode,
  UploadStatus,
  ScottyJobStatus,
} from "../../shared/scotty/index";

/** Mirror of shared constant — keep in sync with `shared/scotty/version.ts`. */
export const SCOTTY_CONTRACT_VERSION = "1.0.0" as const;
/** Mirror of shared constant — keep in sync with `shared/scotty/upload.ts`. */
export const SCOTTY_MAX_DURATION_SEC = 1800 as const;
export const SOURCE_VIDEO_EXPIRED_MESSAGE =
  "Source gameplay video expired and was deleted after the retention period. Your coaching report remains available.";
