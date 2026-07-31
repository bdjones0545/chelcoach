/**
 * In-process extraction job runner (MVP).
 *
 * - Commit returns immediately; work continues asynchronously.
 * - Deduplicated by clipId (inFlight + queued set).
 * - Concurrency bounded by mediaConfig.maxConcurrentJobs.
 * - Clear interface (enqueueExtraction) so a worker can replace this later.
 * - Tracks child work via AbortControllers for best-effort shutdown.
 *
 * Limitations (documented): jobs die on process restart; not multi-instance safe;
 * shares the API process CPU/RAM with HTTP. Fine for single-clip MVP on a Reserved VM.
 */
import { mediaConfig } from "../media/config";
import { MediaProcessingError } from "../media/errors";
import { runExtractionPipeline } from "../media/pipeline";
import type { ProcessRunner } from "../media/processRunner";
import {
  beginExtraction,
  completeExtraction,
  getClip,
  markFailed,
  updateExtractionProgress,
} from "../store";

const waiting: string[] = [];
const inFlight = new Set<string>();
const abortByClip = new Map<string, AbortController>();
let active = 0;
let runnerOverride: ProcessRunner | undefined;

export function setExtractionRunnerForTests(runner: ProcessRunner | undefined): void {
  runnerOverride = runner;
}

const MAX_QUEUE_DEPTH = () => mediaConfig.maxConcurrentJobs * 5;

/** Enqueue extraction for a committed clip. No-op if already queued/running/terminal. */
export function enqueueExtraction(clipId: string): void {
  const clip = getClip(clipId);
  if (!clip) return;
  if (clip.status === "complete" || clip.status === "failed") return;
  if (inFlight.has(clipId) || waiting.includes(clipId)) return;

  if (waiting.length + active >= MAX_QUEUE_DEPTH()) {
    markFailed(
      clipId,
      "processing_busy",
      "ChelCoach is busy processing other clips. Wait a moment and try again.",
    );
    return;
  }

  waiting.push(clipId);
  pump();
}

function pump(): void {
  while (active < mediaConfig.maxConcurrentJobs && waiting.length > 0) {
    const clipId = waiting.shift();
    if (!clipId) break;
    if (inFlight.has(clipId)) continue;
    const clip = getClip(clipId);
    if (!clip || clip.status === "complete" || clip.status === "failed") continue;
    active += 1;
    inFlight.add(clipId);
    void runOne(clipId).finally(() => {
      inFlight.delete(clipId);
      abortByClip.delete(clipId);
      active -= 1;
      pump();
    });
  }
}

async function runOne(clipId: string): Promise<void> {
  const controller = new AbortController();
  abortByClip.set(clipId, controller);

  try {
    const clip = beginExtraction(clipId);
    if (clip.status === "complete" || clip.status === "failed") return;

    const result = await runExtractionPipeline({
      clipId,
      storageKey: clip.storageKey,
      sizeBytes: clip.storedBytes ?? clip.sizeBytes,
      runner: runnerOverride,
      onStage: (stage, progress) => {
        if (controller.signal.aborted) return;
        updateExtractionProgress(clipId, stage, progress);
      },
    });

    if (controller.signal.aborted) return;
    completeExtraction(clipId, result);
    console.log(
      `[chelcoach-api] extraction complete clip=${clipId} frames=${result.frameCount} ms=${result.durationMs}`,
    );
  } catch (err) {
    if (controller.signal.aborted) return;
    if (err instanceof MediaProcessingError) {
      console.error(`[chelcoach-api] extraction failed clip=${clipId} code=${err.internalCode}`);
      markFailed(clipId, err.publicCode, err.userMessage);
      return;
    }
    console.error(
      `[chelcoach-api] extraction failed clip=${clipId}:`,
      err instanceof Error ? err.message : err,
    );
    markFailed(clipId, "extraction_failed", "Something went wrong while preparing your clip. Try again in a moment.");
  }
}

/** Best-effort cancel in-flight work on shutdown. */
export function shutdownExtractionQueue(): void {
  waiting.length = 0;
  for (const controller of abortByClip.values()) controller.abort();
}

/** Test helpers */
export function resetExtractionQueueForTests(): void {
  waiting.length = 0;
  inFlight.clear();
  abortByClip.clear();
  active = 0;
  runnerOverride = undefined;
}

export function extractionQueueSnapshot(): { waiting: number; active: number; inFlight: string[] } {
  return { waiting: waiting.length, active, inFlight: [...inFlight] };
}
