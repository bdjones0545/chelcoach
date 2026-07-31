/**
 * End-to-end extraction pipeline for one clip:
 * read storage → workspace → probe → sample → extract → result → cleanup.
 */
import { getStorage } from "../storage";
import { MediaProcessingError } from "./errors";
import { extractFrames } from "./extract";
import { probeVideo } from "./probe";
import type { ProcessRunner } from "./processRunner";
import { runProcess } from "./processRunner";
import { sampleTimestamps } from "./sample";
import type { ExtractionResult } from "./types";
import { cleanupJobWorkspace, createJobWorkspace, writeSourceFile } from "./workspace";

export interface RunExtractionOptions {
  clipId: string;
  storageKey: string;
  sizeBytes: number;
  runner?: ProcessRunner;
  /** Optional progress hook for truthful stage updates. */
  onStage?: (stage: "inspecting_video" | "extracting_frames" | "finalizing", progress: number) => void;
}

export async function runExtractionPipeline(options: RunExtractionOptions): Promise<ExtractionResult> {
  const started = Date.now();
  const runner = options.runner ?? runProcess;
  const workspace = await createJobWorkspace(options.clipId);
  const warnings: string[] = [];

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

    // Progress based on real completed frames.
    options.onStage?.(
      "extracting_frames",
      35 + Math.round((frames.length / Math.max(timestampsSec.length, 1)) * 50),
    );

    options.onStage?.("finalizing", 90);

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

    // Strip absolute paths before returning a retained copy — workspace is deleted next.
    // Future AI phase can re-extract or persist frames deliberately; MVP keeps metadata only.
    return {
      ...result,
      frames: frames.map((f) => ({ ...f, path: "" })),
    };
  } finally {
    await cleanupJobWorkspace(workspace);
  }
}
