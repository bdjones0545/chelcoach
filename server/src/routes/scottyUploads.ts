/**
 * Scotty Step 2 upload-session routes (streamed, ownership-scoped).
 *
 *   POST   /api/uploads
 *   PUT    /api/uploads/:uploadId/content   (streamed body)
 *   POST   /api/uploads/:uploadId/complete
 *   GET    /api/uploads/:uploadId
 *   DELETE /api/uploads/:uploadId
 */
import { Router } from "express";
import { requireOwnerAuth, type AuthedRequest } from "../auth/session";
import { getMaxUploadBytes } from "../retention/policy";
import { limits } from "../security/rateLimit";
import {
  cancelUpload,
  completeUpload,
  createUploadSession,
  finishStreamedUpload,
  getUploadForOwner,
  rejectOversizedUpload,
  UploadServiceError,
} from "../uploads/service";

export const scottyUploadsRouter = Router();

function sendError(res: import("express").Response, err: unknown): void {
  if (err instanceof UploadServiceError) {
    res.status(err.httpStatus).json({
      error: err.code,
      message: err.message,
      retryable: false,
    });
    return;
  }
  const message = err instanceof Error ? err.message : "Unexpected error.";
  console.error("[chelcoach-upload] error:", message);
  res.status(500).json({ error: "ANALYSIS_FAILED", message: "Unexpected error." });
}

scottyUploadsRouter.post("/uploads", requireOwnerAuth, limits.uploadCreate, async (req, res) => {
  try {
    const { ownerId } = req as AuthedRequest;
    const body = await createUploadSession(ownerId, req.body);
    res.status(201).json(body);
  } catch (err) {
    sendError(res, err);
  }
});

/**
 * Streamed PUT — no express.raw() / full Buffer.
 * Content-Length (when present) is checked up-front; byte limit enforced while streaming.
 */
function uploadIdParam(req: import("express").Request): string {
  const raw = req.params.uploadId;
  return Array.isArray(raw) ? String(raw[0]) : String(raw);
}

scottyUploadsRouter.put(
  "/uploads/:uploadId/content",
  requireOwnerAuth,
  limits.uploadStream,
  async (req, res) => {
  const { ownerId } = req as AuthedRequest;
  const uploadId = uploadIdParam(req);
  try {
    const maxBytes = getMaxUploadBytes();
    const declared = Number(req.header("content-length"));
    if (Number.isFinite(declared) && declared > maxBytes) {
      // Reject before streaming, but still expire the session and clear partials.
      await rejectOversizedUpload(ownerId, uploadId);
      res.status(413).json({
        error: "VIDEO_FILE_TOO_LARGE",
        message: "Video file exceeds the maximum upload size.",
      });
      return;
    }
    // Disable request buffering timeouts for large streams.
    req.socket.setTimeout(0);
    const detail = await finishStreamedUpload(ownerId, uploadId, req);
    res.status(200).json(detail);
  } catch (err) {
    sendError(res, err);
  }
},
);

scottyUploadsRouter.post("/uploads/:uploadId/complete", requireOwnerAuth, async (req, res) => {
  try {
    const { ownerId } = req as AuthedRequest;
    const detail = await completeUpload(ownerId, uploadIdParam(req));
    res.status(200).json(detail);
  } catch (err) {
    sendError(res, err);
  }
});

scottyUploadsRouter.get("/uploads/:uploadId", requireOwnerAuth, async (req, res) => {
  try {
    const { ownerId } = req as AuthedRequest;
    const detail = await getUploadForOwner(ownerId, uploadIdParam(req));
    res.status(200).json(detail);
  } catch (err) {
    sendError(res, err);
  }
});

scottyUploadsRouter.delete("/uploads/:uploadId", requireOwnerAuth, async (req, res) => {
  try {
    const { ownerId } = req as AuthedRequest;
    const detail = await cancelUpload(ownerId, uploadIdParam(req));
    res.status(200).json(detail);
  } catch (err) {
    sendError(res, err);
  }
});
