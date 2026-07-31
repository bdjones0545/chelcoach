/** Inspected video metadata (internal — not part of the public report contract). */
export interface VideoMetadata {
  durationSec: number;
  width: number;
  height: number;
  /** Average frame rate when available; 0 if unknown. */
  fps: number;
  codec: string;
  container: string;
  /** Rotation degrees from side-data / tags when present (0 if none). */
  rotationDeg: number;
  hasVideoStream: boolean;
  sizeBytes: number;
}

/** One extracted analysis input frame. */
export interface ExtractedFrame {
  index: number;
  timestampSec: number;
  /** Absolute path while the job workspace exists; cleared after cleanup. */
  path: string;
  width: number;
  height: number;
}

/**
 * Internal extraction result for a future AI phase to consume.
 * Not exposed on the public AnalysisReport contract.
 */
export interface ExtractionResult {
  clipId: string;
  metadata: VideoMetadata;
  timestampsSec: number[];
  frameCount: number;
  frames: ExtractedFrame[];
  warnings: string[];
  durationMs: number;
  completedAt: string;
}
