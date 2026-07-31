/**
 * Clip / analysis routes.
 *
 *   POST /api/clips/:id/commit    finalize an uploaded clip (attaches the static report)
 *   GET  /api/clips/:id/status    public analysis-job status (Processing-screen contract)
 *   GET  /api/clips/:id           clip status + report once complete
 *   GET  /api/clips/:id/analysis  the report alone, once complete
 *
 * Upload init + file bytes live in routes/uploads.ts. No ffmpeg/AI yet.
 */
import { Router } from "express";
import { toAnalysisJobStatus } from "../analysisStatus";
import type { AnalysisResponse, ClipResponse, CommitResponse } from "../contract";
import { clipIdParamSchema } from "../contract";
import { ClipStoreError, commitClip, getClip } from "../store";

export const clipsRouter = Router();

function parseClipId(raw: string | string[]): string | null {
  const value = Array.isArray(raw) ? raw[0] : raw;
  const parsed = clipIdParamSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function rejectMalformedId(res: import("express").Response): void {
  res.status(400).json({ error: "invalid_clip_id", message: "Malformed clip id." });
}

/** POST /api/clips/:id/commit — finalize the clip (or synthesize the demo clip). */
clipsRouter.post("/clips/:id/commit", (req, res) => {
  const id = parseClipId(req.params.id);
  if (!id) {
    rejectMalformedId(res);
    return;
  }
  try {
    const clip = commitClip(id);
    const body: CommitResponse = { clipId: clip.id, jobId: clip.jobId ?? "", status: clip.status };
    res.status(200).json(body);
  } catch (err) {
    if (err instanceof ClipStoreError) {
      res.status(err.httpStatus).json({ error: err.code, message: err.message });
      return;
    }
    throw err;
  }
});

/**
 * GET /api/clips/:id/status — truthful analysis-job status for the Processing screen.
 * Response is validated against the shared `analysisJobStatusSchema` before send.
 */
clipsRouter.get("/clips/:id/status", (req, res) => {
  const id = parseClipId(req.params.id);
  if (!id) {
    rejectMalformedId(res);
    return;
  }
  const clip = getClip(id);
  if (!clip) {
    res.status(404).json({ error: "not_found", message: "No such clip." });
    return;
  }
  res.status(200).json(toAnalysisJobStatus(clip));
});

/** GET /api/clips/:id — clip status plus the report once complete. */
clipsRouter.get("/clips/:id", (req, res) => {
  const id = parseClipId(req.params.id);
  if (!id) {
    rejectMalformedId(res);
    return;
  }
  const clip = getClip(id);
  if (!clip) {
    res.status(404).json({ error: "not_found", message: "No such clip." });
    return;
  }
  const body: ClipResponse = {
    clipId: clip.id,
    status: clip.status,
    phaseProgress: clip.status === "complete" ? 100 : clip.status === "queued" ? 50 : 0,
    ...(clip.report ? { report: clip.report } : {}),
    ...(clip.errorCode ? { errorCode: clip.errorCode } : {}),
    ...(clip.errorMessage ? { errorMessage: clip.errorMessage } : {}),
  };
  res.status(200).json(body);
});

/** GET /api/clips/:id/analysis — the report alone, once complete. */
clipsRouter.get("/clips/:id/analysis", (req, res) => {
  const id = parseClipId(req.params.id);
  if (!id) {
    rejectMalformedId(res);
    return;
  }
  const clip = getClip(id);
  if (!clip) {
    res.status(404).json({ error: "not_found", message: "No such clip." });
    return;
  }
  if (clip.status !== "complete" || !clip.report) {
    res.status(409).json({ error: "not_ready", message: `Clip status is "${clip.status}".` });
    return;
  }
  const body: AnalysisResponse = { clipId: clip.id, report: clip.report };
  res.status(200).json(body);
});
