/**
 * Backend report / status / upload clients (behind VITE_USE_BACKEND_REPORTS).
 *
 * Live upload path: init → PUT bytes → commit → (Processing polls status) →
 * fetch report once on completed. Demo / flag-off paths never pretend to be live.
 *
 * Types from the shared contract are imported TYPE-ONLY so Zod stays out of the
 * client bundle; status payloads are structurally validated in analysisJobStatus.ts.
 */
import type { AnalysisJobStatus, AnalysisReport } from "../../shared/analysisContract";
import {
  defaultVideoPoster,
  momentThumbnailByType,
  type CoachingMoment,
  type GameReport,
} from "../data/mockData";
import { parseAnalysisJobStatus } from "./analysisJobStatus";

export const USE_BACKEND_REPORTS = import.meta.env.VITE_USE_BACKEND_REPORTS === "true";

const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? "http://localhost:3001";

/** Deterministic demo clip id used by intentional demo flows (not silent fallback). */
export const DEMO_CLIP_ID = "static-demo-clip";

/** Fill local SVG fallbacks for imagery the API omits, producing the frontend shape. */
export function normalizeReport(api: AnalysisReport): GameReport {
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

export class ReportApiError extends Error {
  kind: "network" | "http" | "not_ready" | "invalid";
  status: number | undefined;

  constructor(message: string, kind: "network" | "http" | "not_ready" | "invalid", status?: number) {
    super(message);
    this.name = "ReportApiError";
    this.kind = kind;
    this.status = status;
  }
}

/** GET /api/clips/:id/status — validated against the shared status shape. */
export async function fetchAnalysisJobStatus(
  clipId: string,
  signal?: AbortSignal,
): Promise<AnalysisJobStatus> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE_URL}/api/clips/${clipId}/status`, { signal });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    throw new ReportApiError("Status request failed.", "network");
  }
  if (res.status === 404) throw new ReportApiError("Clip not found.", "http", 404);
  if (!res.ok) throw new ReportApiError(`Status fetch failed: ${res.status}`, "http", res.status);

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new ReportApiError("Status response was not JSON.", "invalid", res.status);
  }
  return parseAnalysisJobStatus(body);
}

/** GET /api/clips/:id/analysis — report once the job is completed. */
export async function fetchClipReport(clipId: string, signal?: AbortSignal): Promise<GameReport> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE_URL}/api/clips/${clipId}/analysis`, { signal });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    throw new ReportApiError("Report request failed.", "network");
  }
  if (res.status === 409) throw new ReportApiError("Report not ready.", "not_ready", 409);
  if (!res.ok) throw new ReportApiError(`Report fetch failed: ${res.status}`, "http", res.status);

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new ReportApiError("Report response was not JSON.", "invalid", res.status);
  }
  const report = (body as { report?: AnalysisReport }).report;
  if (!report || typeof report !== "object") {
    throw new ReportApiError("Report payload missing.", "invalid", res.status);
  }
  return normalizeReport(report);
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

/**
 * init → PUT bytes → commit. Returns the new clipId.
 * Does NOT poll status or fetch the report — Processing owns that lifecycle.
 */
export async function uploadClip(file: File, onProgress?: (percent: number) => void): Promise<string> {
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
