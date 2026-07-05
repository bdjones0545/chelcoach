/**
 * Backend report read-path (behind the VITE_USE_BACKEND_REPORTS flag).
 *
 * Proves the frontend can consume the backend's static AnalysisReport with zero
 * shape drift. No upload/storage/AI: we commit a fixed demo clip id, poll until the
 * (instant) analysis completes, and normalize the report into the frontend's GameReport
 * shape — filling local SVG fallbacks for any imagery the API omits.
 *
 * Types are imported TYPE-ONLY from the shared contract, so `zod` never enters the
 * client bundle.
 */
import type { AnalysisReport } from "../../shared/analysisContract";
import {
  defaultVideoPoster,
  momentThumbnailByType,
  type CoachingMoment,
  type GameReport,
} from "../data/mockData";

export const USE_BACKEND_REPORTS = import.meta.env.VITE_USE_BACKEND_REPORTS === "true";

const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? "http://localhost:3001";

/** Deterministic demo clip id for the static loop (no real upload yet). */
const DEMO_CLIP_ID = "static-demo-clip";

interface ClipResponse {
  clipId: string;
  status: string;
  phaseProgress: number;
  report?: AnalysisReport;
}

/** Fill local SVG fallbacks for imagery the API omits, producing the frontend shape. */
function normalize(api: AnalysisReport): GameReport {
  const coachingMoments: CoachingMoment[] = api.coachingMoments.map((m) => ({
    ...m,
    thumbnail: m.thumbnail ?? momentThumbnailByType[m.type],
  }));

  const filmRoom: GameReport["filmRoom"] = {
    ...api.filmRoom,
    videoPoster: api.filmRoom.videoPoster ?? defaultVideoPoster,
  };

  return { scorecard: api.scorecard, coachingMoments, filmRoom };
}

async function commitDemoClip(): Promise<void> {
  const res = await fetch(`${API_BASE_URL}/api/clips/${DEMO_CLIP_ID}/commit`, { method: "POST" });
  if (!res.ok) throw new Error(`commit failed: ${res.status}`);
}

async function fetchClip(): Promise<ClipResponse> {
  const res = await fetch(`${API_BASE_URL}/api/clips/${DEMO_CLIP_ID}`);
  if (!res.ok) throw new Error(`clip fetch failed: ${res.status}`);
  return (await res.json()) as ClipResponse;
}

/**
 * Commit the demo clip, poll until complete, and return a normalized GameReport.
 * Throws on network/timeout so the caller can fall back to the mock report.
 */
export async function fetchBackendReport(signal?: AbortSignal): Promise<GameReport> {
  await commitDemoClip();

  const maxAttempts = 10;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (signal?.aborted) throw new Error("aborted");
    const clip = await fetchClip();
    if (clip.status === "complete" && clip.report) {
      return normalize(clip.report);
    }
    if (clip.status === "failed") throw new Error("analysis failed");
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("analysis timed out");
}
