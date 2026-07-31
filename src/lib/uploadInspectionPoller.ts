/**
 * Upload inspection polling (Step 10.1D).
 * Reuses Step 7 polling patterns: server pollAfterMs, visibility pause, no overlap.
 * Inspection uses stage labels only — no fake percentages.
 */
import { getUpload, type PublicUploadDetail } from "./scottyUploadApi";

export const MIN_UPLOAD_POLL_MS = 1000;
export const MAX_UPLOAD_POLL_MS = 15_000;

export type UploadInspectionPoller = {
  start(): void;
  stop(): void;
  dispose(): void;
};

function clamp(ms: number | null | undefined): number | null {
  if (ms === null || ms === undefined) return null;
  if (!Number.isFinite(ms)) return MIN_UPLOAD_POLL_MS;
  return Math.min(MAX_UPLOAD_POLL_MS, Math.max(MIN_UPLOAD_POLL_MS, Math.floor(ms)));
}

function isTerminal(detail: PublicUploadDetail): boolean {
  if (detail.uploadStatus === "ready") return true;
  if (detail.uploadStatus === "expired" || detail.uploadStatus === "deleted") return true;
  const st = detail.inspection?.status;
  if (st === "failed" || st === "cancelled" || st === "expired") return true;
  return false;
}

export function createUploadInspectionPoller(input: {
  uploadId: string;
  onUpdate: (detail: PublicUploadDetail) => void;
  onError?: (message: string) => void;
}): UploadInspectionPoller {
  let stopped = false;
  let inFlight = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let unsubVis: (() => void) | null = null;

  const clearTimer = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const schedule = (ms: number) => {
    clearTimer();
    if (stopped) return;
    timer = setTimeout(() => {
      void tick();
    }, ms);
  };

  const tick = async () => {
    if (stopped || inFlight) return;
    if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      schedule(MIN_UPLOAD_POLL_MS * 2);
      return;
    }
    inFlight = true;
    try {
      const detail = await getUpload(undefined, input.uploadId);
      if (stopped) return;
      input.onUpdate(detail);
      if (isTerminal(detail)) {
        stopped = true;
        clearTimer();
        return;
      }
      const wait = clamp(detail.pollAfterMs ?? detail.inspection?.pollAfterMs ?? 2000) ?? 2000;
      schedule(wait);
    } catch (err) {
      if (stopped) return;
      input.onError?.(err instanceof Error ? err.message : "Failed to load upload status");
      schedule(4000);
    } finally {
      inFlight = false;
    }
  };

  return {
    start() {
      stopped = false;
      if (typeof document !== "undefined") {
        const onVis = () => {
          if (document.visibilityState === "visible") void tick();
        };
        document.addEventListener("visibilitychange", onVis);
        unsubVis = () => document.removeEventListener("visibilitychange", onVis);
      }
      void tick();
    },
    stop() {
      stopped = true;
      clearTimer();
    },
    dispose() {
      stopped = true;
      clearTimer();
      unsubVis?.();
      unsubVis = null;
    },
  };
}

export function inspectionStageLabel(detail: PublicUploadDetail): string {
  if (detail.uploadStatus === "ready") return "Ready for player identification";
  const st = detail.inspection?.status;
  switch (st) {
    case "queued":
      return "Waiting for verification";
    case "claimed":
    case "downloading":
      return "Waiting for verification";
    case "inspecting":
      return "Inspecting gameplay video";
    case "validating":
      return "Validating media";
    case "completed":
      return "Ready for player identification";
    case "failed":
      return detail.inspection?.message || "Verification failed";
    default:
      if (detail.uploadStatus === "processing") return "Waiting for verification";
      if (detail.uploadStatus === "uploaded") return "Upload complete";
      return "Upload complete";
  }
}
