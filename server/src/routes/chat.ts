import { Router } from "express";
import { requireOwnerAuth, type AuthedRequest } from "../auth/session";
import { limits } from "../security/rateLimit";
import { AnalysisStatusError } from "../provider/statusService";
import { ChatServiceError, listChat, sendChat } from "../chat/service";

export const chatRouter = Router();

function requestIdParam(req: import("express").Request): string {
  const raw = req.params.applicationRequestId;
  return Array.isArray(raw) ? String(raw[0]) : String(raw);
}

function sendError(res: import("express").Response, err: unknown): void {
  if (err instanceof ChatServiceError) {
    res.status(err.httpStatus).json({ error: err.code, message: err.message, retryable: err.retryable });
    return;
  }
  if (err instanceof AnalysisStatusError) {
    res.status(err.httpStatus).json({ error: err.code, message: err.message, retryable: err.code === "REPORT_NOT_READY" });
    return;
  }
  const message = err instanceof Error ? err.message : "Unexpected error.";
  console.error("[chelcoach-chat] error:", message);
  res.status(500).json({ error: "ANALYSIS_FAILED", message: "Unexpected error." });
}

/** GET /api/analysis/:applicationRequestId/chat — the conversation so far (owner only). */
chatRouter.get("/analysis/:applicationRequestId/chat", requireOwnerAuth, limits.reportRead, async (req, res) => {
  try {
    const { ownerId } = req as AuthedRequest;
    const messages = await listChat({ ownerId, applicationRequestId: requestIdParam(req) });
    res.setHeader("Cache-Control", "no-store, private");
    res.json({ messages });
  } catch (err) {
    sendError(res, err);
  }
});

/** POST /api/analysis/:applicationRequestId/chat { message } — ask Scottie one question. */
chatRouter.post("/analysis/:applicationRequestId/chat", requireOwnerAuth, limits.chat, async (req, res) => {
  try {
    const { ownerId } = req as AuthedRequest;
    const body = (req.body ?? {}) as { message?: unknown };
    const result = await sendChat({ ownerId, applicationRequestId: requestIdParam(req), message: body.message });
    res.setHeader("Cache-Control", "no-store, private");
    res.json(result);
  } catch (err) {
    sendError(res, err);
  }
});
