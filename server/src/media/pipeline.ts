/**
 * End-to-end extraction pipeline for one clip:
 * read storage → workspace → probe → sample → extract.
 *
 * Temporary frames remain on disk until the caller invokes `cleanup()`.
 * AI analysis must run before cleanup so it can reuse extracted JPEGs.
 */
import { getStorage } from "../storage";
import { MediaProcessingError } from "./errors";
import { extractFrames } from "./extract";
import { probeVideo } from "./probe";
import type { ProcessRunner } from "./processRunner";
import { runProcess } from "./processRunner";
import { sampleTimestamps } from "./sample";
import type { ExtractionResult } from "./types";
import {
  cleanupJobWorkspace,
  createJobWorkspace,
  writeSourceFile,
  type JobWorkspace,
} from "./workspace";

export interface RunExtractionOptions {
  clipId: string;
  storageKey: string;
  sizeBytes: number;
  runner?: ProcessRunner;
  /** Optional progress hook for truthful stage updates. */
  onStage?: (stage: "inspecting_video" | "extracting_frames", progress: number) => void;
}

export interface ExtractionSession {
  result: ExtractionResult;
  workspace: JobWorkspace;
  /** Always call — safe to invoke more than once. */
  cleanup: () => Promise<void>;
}

/** Strip absolute paths before retaining extraction metadata in the clip store. */
export function stripFramePaths(result: ExtractionResult): ExtractionResult {
  return {
    ...result,
    frames: result.frames.map((f) => ({ ...f, path: "" })),
  };
}

export async function runExtractionPipeline(
  options: RunExtractionOptions,
): Promise<ExtractionSession> {
  const started = Date.now();
  const runner = options.runner ?? runProcess;
  const workspace = await createJobWorkspace(options.clipId);
  const warnings: string[] = [];
  let cleaned = false;

  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    await cleanupJobWorkspace(workspace);
  };

  try {
    options.onStage?.("inspecting_video", 15);

    let bytes: Buffer;
    try {
      bytes = await getStorage().get(options.storageKey);
    } catch (err) {
      throw new MediaProcessingError(
        "STORAGE_READ_FAILED",
        err instanceof Error ? err.message : "storage get failed",
      );
    }
    if (!bytes.length) {
      throw new MediaProcessingError("STORAGE_READ_FAILED", "empty object");
    }

    await writeSourceFile(workspace, bytes);
    const metadata = await probeVideo(workspace.sourcePath, options.sizeBytes || bytes.length, runner);
    const timestampsSec = sampleTimestamps(metadata.durationSec);

    options.onStage?.("extracting_frames", 35);
    const frames = await extractFrames({
      sourcePath: workspace.sourcePath,
      framesDir: workspace.framesDir,
      timestampsSec,
      metadata,
      runner,
    });

    options.onStage?.(
      "extracting_frames",
      35 + Math.round((frames.length / Math.max(timestampsSec.length, 1)) * 20),
    );

    const result: ExtractionResult = {
      clipId: options.clipId,
      metadata,
      timestampsSec,
      frameCount: frames.length,
      frames,
      warnings,
      durationMs: Date.now() - started,
      completedAt: new Date().toISOString(),
    };

    return { result, workspace, cleanup };
  } catch (err) {
    await cleanup();
    throw err;
  }
}
