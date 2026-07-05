/**
 * Clip / analysis routes.
 *
 *   POST /api/clips/:id/commit    finalize an uploaded clip (Phase 2: attaches the static report)
 *   GET  /api/clips/:id           clip status + report once complete
 *   GET  /api/clips/:id/analysis  the report alone, once complete
 *
 * Upload init + file bytes live in routes/uploads.ts. No ffmpeg/AI yet.
 */
import { Router } from "express";
import type { AnalysisResponse, ClipResponse, CommitResponse } from "../contract";
import { ClipStoreError, commitClip, getClip } from "../store";

export const clipsRouter = Router();

/** POST /api/clips/:id/commit — finalize the clip (or synthesize the demo clip). */
clipsRouter.post("/clips/:id/commit", (req, res) => {
  try {
    const clip = commitClip(req.params.id);
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

/** GET /api/clips/:id — clip status plus the report once complete. */
clipsRouter.get("/clips/:id", (req, res) => {
  const clip = getClip(req.params.id);
  if (!clip) {
    res.status(404).json({ error: "not_found", message: "No such clip." });
    return;
  }
  const body: ClipResponse = {
    clipId: clip.id,
    status: clip.status,
    phaseProgress: clip.status === "complete" ? 100 : clip.status === "queued" ? 50 : 0,
    ...(clip.report ? { report: clip.report } : {}),
  };
  res.status(200).json(body);
});

/** GET /api/clips/:id/analysis — the report alone, once complete. */
clipsRouter.get("/clips/:id/analysis", (req, res) => {
  const clip = getClip(req.params.id);
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
