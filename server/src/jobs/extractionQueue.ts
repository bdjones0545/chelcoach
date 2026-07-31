/**
 * In-process analysis job runner (MVP).
 *
 * Sequence: queued → extracting (inspect/extract) → analyzing (AI + validate)
 * → completed | failed. Temporary frames are cleaned up on every exit path.
 *
 * - Commit returns immediately; work continues asynchronously.
 * - Deduplicated by clipId (inFlight + queued set) — no duplicate provider charges.
 * - Concurrency bounded by mediaConfig.maxConcurrentJobs.
 * - Clear interface (enqueueExtraction) so a worker can replace this later.
 *
 * Limitations: jobs die on process restart; not multi-instance safe;
 * shares the API process CPU/RAM with HTTP.
 */
import { analyzeExtractedGameplay } from "../ai/analyze";
import { AiAnalysisError } from "../ai/errors";
import { isAiConfigured } from "../ai/config";
import { getInjectedAnalysisProvider } from "../ai/provider";
import { mediaConfig } from "../media/config";
import { MediaProcessingError } from "../media/errors";
import { runExtractionPipeline, stripFramePaths } from "../media/pipeline";
import type { ProcessRunner } from "../media/processRunner";
import {
  beginExtraction,
  completeAnalysis,
  getClip,
  markFailed,
  recordExtraction,
  updateJobProgress,
} from "../store";

const waiting: string[] = [];
const inFlight = new Set<string>();
const abortByClip = new Map<string, AbortController>();
/** Clips that already started a provider-bound analysis attempt (charge guard). */
const analysisStarted = new Set<string>();
let active = 0;
let runnerOverride: ProcessRunner | undefined;

export function setExtractionRunnerForTests(runner: ProcessRunner | undefined): void {
  runnerOverride = runner;
}

const MAX_QUEUE_DEPTH = () => mediaConfig.maxConcurrentJobs * 5;

/** Enqueue analysis for a committed clip. No-op if already queued/running/terminal. */
export function enqueueExtraction(clipId: string): void {
  const clip = getClip(clipId);
  if (!clip) return;
  if (clip.status === "complete" || clip.status === "failed") return;
  if (inFlight.has(clipId) || waiting.includes(clipId)) return;
  if (analysisStarted.has(clipId)) return;

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
  let cleanup: (() => Promise<void>) | undefined;

  try {
    const clip = beginExtraction(clipId);
    if (clip.status === "complete" || clip.status === "failed") return;

    // Live mode without AI configuration fails before extraction work that would
    // only lead to an inevitable AI failure — still truthful, saves FFmpeg CPU.
    // Exception: injected/fake provider for tests and AI_PROVIDER=fake.
    if (!isAiConfigured() && !getInjectedAnalysisProvider()) {
      markFailed(
        clipId,
        "ai_not_configured",
        "Gameplay analysis is not configured on this server. Try again later.",
      );
      return;
    }

    const session = await runExtractionPipeline({
      clipId,
      storageKey: clip.storageKey,
      sizeBytes: clip.storedBytes ?? clip.sizeBytes,
      runner: runnerOverride,
      onStage: (stage, progress) => {
        if (controller.signal.aborted) return;
        updateJobProgress(clipId, stage, progress);
      },
    });
    cleanup = session.cleanup;

    if (controller.signal.aborted) return;

    const retained = stripFramePaths(session.result);
    recordExtraction(clipId, retained);

    // Guard: only one provider attempt chain per clipId for this process lifetime.
    if (analysisStarted.has(clipId)) {
      console.warn(`[chelcoach-api] skipping duplicate analysis clip=${clipId}`);
      return;
    }
    analysisStarted.add(clipId);

    updateJobProgress(clipId, "analyzing_gameplay", 60, "analyzing");

    const analyzed = await analyzeExtractedGameplay(session.result, {
      signal: controller.signal,
      onStage: (stage, progress) => {
        if (controller.signal.aborted) return;
        updateJobProgress(clipId, stage, progress, "analyzing");
      },
    });

    if (controller.signal.aborted) return;

    updateJobProgress(clipId, "finalizing", 95, "analyzing");
    completeAnalysis(clipId, analyzed.report, analyzed.provenance, retained);
    console.log(
      `[chelcoach-api] analysis complete clip=${clipId} source=${analyzed.provenance.reportSource} provider=${analyzed.provenance.provider} frames=${retained.frameCount}`,
    );
  } catch (err) {
    if (controller.signal.aborted) return;
    if (err instanceof MediaProcessingError) {
      console.error(`[chelcoach-api] extraction failed clip=${clipId} code=${err.internalCode}`);
      markFailed(clipId, err.publicCode, err.userMessage);
      return;
    }
    if (err instanceof AiAnalysisError) {
      console.error(`[chelcoach-api] ai failed clip=${clipId} code=${err.internalCode}`);
      markFailed(clipId, err.publicCode, err.userMessage);
      return;
    }
    console.error(
      `[chelcoach-api] job failed clip=${clipId}:`,
      err instanceof Error ? err.message : err,
    );
    markFailed(
      clipId,
      "analysis_internal_error",
      "Something went wrong while analyzing your clip. Try again in a moment.",
    );
  } finally {
    if (cleanup) {
      try {
        await cleanup();
      } catch (cleanupErr) {
        console.error(
          `[chelcoach-api] workspace cleanup failed clip=${clipId}:`,
          cleanupErr instanceof Error ? cleanupErr.message : cleanupErr,
        );
      }
    }
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
  analysisStarted.clear();
  active = 0;
  runnerOverride = undefined;
}

export function extractionQueueSnapshot(): {
  waiting: number;
  active: number;
  inFlight: string[];
  analysisStarted: string[];
} {
  return {
    waiting: waiting.length,
    active,
    inFlight: [...inFlight],
    analysisStarted: [...analysisStarted],
  };
}
