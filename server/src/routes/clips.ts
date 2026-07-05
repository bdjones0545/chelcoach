/**
 * Clip / analysis routes.
 *
 * Phase 1 (static loop): `commit` and the clip GETs are wired against an in-memory
 * store returning the deterministic sample report — this proves the contract-driven
 * loop with NO storage/ffmpeg/AI. `uploads/init` stays a placeholder until real
 * upload + signed URLs land.
 */
import { Router } from "express";
import type { Response } from "express";
import type { AnalysisResponse, ClipResponse, CommitResponse } from "../contract";
import { uploadInitRequestSchema } from "../contract";
import { commitClip, getClip } from "../store";

export const clipsRouter = Router();

function notImplemented(res: Response, endpoint: string, arrivesIn: string) {
  res.status(501).json({
    error: "not_implemented",
    message: `${endpoint} is a placeholder. Arrives in ${arrivesIn}.`,
  });
}

/** POST /api/uploads/init — validate + hand back a signed upload URL (later phase). */
clipsRouter.post("/uploads/init", (req, res) => {
  const parsed = uploadInitRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: "invalid_request",
      message: "Body must be { filename, contentType, sizeBytes }.",
    });
    return;
  }
  // Real storage + signed URL + clip row creation: next phase.
  notImplemented(res, "POST /api/uploads/init", "the real upload + storage phase");
});

/** POST /api/clips/:id/commit — simulate a completed clip/job in memory. */
clipsRouter.post("/clips/:id/commit", (req, res) => {
  const clip = commitClip(req.params.id);
  const body: CommitResponse = {
    clipId: clip.id,
    jobId: clip.jobId,
    status: clip.status,
  };
  res.status(200).json(body);
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
    phaseProgress: clip.phaseProgress,
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
