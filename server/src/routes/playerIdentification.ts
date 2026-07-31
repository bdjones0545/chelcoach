/**
 * Controlled-player identification + confirmation routes (Step 3).
 */
import { Router } from "express";
import { requireOwnerAuth, type AuthedRequest } from "../auth/session";
import {
  correctIdentification,
  getIdentification,
  IdentificationServiceError,
  noneOfTheAbove,
  openOwnedFrameStream,
  startOrGetIdentification,
  submitConfirmation,
} from "../identification/service";
import { limits } from "../security/rateLimit";

export const playerIdentificationRouter = Router();

function uploadIdParam(req: import("express").Request): string {
  const raw = req.params.uploadId;
  return Array.isArray(raw) ? String(raw[0]) : String(raw);
}

function frameIdParam(req: import("express").Request): string {
  const raw = req.params.frameId;
  return Array.isArray(raw) ? String(raw[0]) : String(raw);
}

function sendError(res: import("express").Response, err: unknown): void {
  if (err instanceof IdentificationServiceError) {
    res.status(err.httpStatus).json({
      error: err.code,
      message: err.message,
      retryable: err.code === "PROCESSING_LEASE_CONFLICT" || err.code === "PLAYER_IDENTIFICATION_ALREADY_RUNNING",
    });
    return;
  }
  const message = err instanceof Error ? err.message : "Unexpected error.";
  console.error("[chelcoach-identity] error:", message);
  res.status(500).json({ error: "ANALYSIS_FAILED", message: "Unexpected error." });
}

playerIdentificationRouter.post(
  "/uploads/:uploadId/player-identification",
  requireOwnerAuth,
  limits.identification,
  async (req, res) => {
    try {
      const { ownerId } = req as AuthedRequest;
      const body = await startOrGetIdentification(ownerId, uploadIdParam(req), req.body);
      res.status(200).json(body);
    } catch (err) {
      sendError(res, err);
    }
  },
);

playerIdentificationRouter.get(
  "/uploads/:uploadId/player-identification",
  requireOwnerAuth,
  async (req, res) => {
    try {
      const { ownerId } = req as AuthedRequest;
      const body = await getIdentification(ownerId, uploadIdParam(req));
      res.status(200).json(body);
    } catch (err) {
      sendError(res, err);
    }
  },
);

playerIdentificationRouter.post(
  "/uploads/:uploadId/player-confirmation",
  requireOwnerAuth,
  limits.confirmation,
  async (req, res) => {
    try {
      const { ownerId } = req as AuthedRequest;
      const body = await submitConfirmation(ownerId, uploadIdParam(req), req.body);
      res.status(200).json(body);
    } catch (err) {
      sendError(res, err);
    }
  },
);

playerIdentificationRouter.post(
  "/uploads/:uploadId/player-confirmation/correct",
  requireOwnerAuth,
  async (req, res) => {
    try {
      const { ownerId } = req as AuthedRequest;
      const body = await correctIdentification(ownerId, uploadIdParam(req), req.body);
      res.status(200).json(body);
    } catch (err) {
      sendError(res, err);
    }
  },
);

playerIdentificationRouter.post(
  "/uploads/:uploadId/player-confirmation/none-of-the-above",
  requireOwnerAuth,
  async (req, res) => {
    try {
      const { ownerId } = req as AuthedRequest;
      const body = await noneOfTheAbove(ownerId, uploadIdParam(req), req.body);
      res.status(200).json(body);
    } catch (err) {
      sendError(res, err);
    }
  },
);

/**
 * Authenticated frame bytes — short cache, no object-key exposure.
 */
playerIdentificationRouter.get(
  "/uploads/:uploadId/player-confirmation/frames/:frameId",
  requireOwnerAuth,
  async (req, res) => {
    try {
      const { ownerId } = req as AuthedRequest;
      const { stream, mimeType, byteSize } = await openOwnedFrameStream(
        ownerId,
        uploadIdParam(req),
        frameIdParam(req),
      );
      res.setHeader("Content-Type", mimeType);
      res.setHeader("Content-Length", String(byteSize));
      res.setHeader("Cache-Control", "private, no-store");
      res.setHeader("X-Content-Type-Options", "nosniff");
      stream.pipe(res);
    } catch (err) {
      sendError(res, err);
    }
  },
);
