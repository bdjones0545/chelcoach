/**
 * Backend report read-path + upload (behind the VITE_USE_BACKEND_REPORTS flag).
 *
 * Phase 2 adds real upload: init → PUT bytes (with progress) → commit → poll → report.
 * There is still no AI: the backend returns the deterministic sample report. When the flag
 * is off, none of this runs and the app uses local mock data unchanged.
 *
 * Types are imported TYPE-ONLY from the shared contract, so `zod` never enters the bundle.
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

/** Deterministic demo clip id used when no real upload has happened (flag on). */
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

async function fetchClip(clipId: string): Promise<ClipResponse> {
  const res = await fetch(`${API_BASE_URL}/api/clips/${clipId}`);
  if (!res.ok) throw new Error(`clip fetch failed: ${res.status}`);
  return (await res.json()) as ClipResponse;
}

/** Poll a clip until its report is ready, then normalize it. */
async function pollClipReport(clipId: string, signal?: AbortSignal): Promise<GameReport> {
  const maxAttempts = 10;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (signal?.aborted) throw new Error("aborted");
    const clip = await fetchClip(clipId);
    if (clip.status === "complete" && clip.report) return normalize(clip.report);
    if (clip.status === "failed") throw new Error("analysis failed");
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("analysis timed out");
}

/** Commit the fixed demo clip (no upload) and return its normalized report. */
export async function fetchBackendReport(signal?: AbortSignal): Promise<GameReport> {
  const res = await fetch(`${API_BASE_URL}/api/clips/${DEMO_CLIP_ID}/commit`, { method: "POST" });
  if (!res.ok) throw new Error(`commit failed: ${res.status}`);
  return pollClipReport(DEMO_CLIP_ID, signal);
}

/** PUT the file bytes to the server with upload-progress callbacks (XHR for progress events). */
function putFileWithProgress(url: string, file: File, onProgress?: (percent: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    xhr.setRequestHeader("Content-Type", file.type || "application/octet-stream");
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) onProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () =>
      xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error(`upload failed: ${xhr.status}`));
    xhr.onerror = () => reject(new Error("upload network error"));
    xhr.send(file);
  });
}

/** init → PUT bytes → commit. Returns the new clipId. */
async function uploadClip(file: File, onProgress?: (percent: number) => void): Promise<string> {
  const initRes = await fetch(`${API_BASE_URL}/api/uploads/init`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      filename: file.name,
      contentType: file.type || "application/octet-stream",
      sizeBytes: file.size,
    }),
  });
  if (!initRes.ok) throw new Error(`upload init failed: ${initRes.status}`);
  const { clipId, uploadUrl } = (await initRes.json()) as { clipId: string; uploadUrl: string };

  await putFileWithProgress(`${API_BASE_URL}${uploadUrl}`, file, onProgress);

  const commitRes = await fetch(`${API_BASE_URL}/api/clips/${clipId}/commit`, { method: "POST" });
  if (!commitRes.ok) throw new Error(`commit failed: ${commitRes.status}`);
  return clipId;
}

/** Upload a real clip and resolve its normalized report. */
export async function analyzeUploadedClip(
  file: File,
  onProgress?: (percent: number) => void,
): Promise<{ clipId: string; report: GameReport }> {
  const clipId = await uploadClip(file, onProgress);
  const report = await pollClipReport(clipId);
  return { clipId, report };
}
