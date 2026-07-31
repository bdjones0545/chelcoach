import { Router } from "express";
import {
  createOwnerSession,
  extractBearerToken,
  logoutSession,
  rotateSession,
} from "../auth/session";
import { getChelCoachConfig } from "../config/chelcoachConfig";
import { limits } from "../security/rateLimit";

export const sessionRouter = Router();

/**
 * POST /api/session — mint a pseudonymous owner session.
 * Blocked in production by default (Option B — no production auth yet).
 */
sessionRouter.post("/session", limits.sessionCreate, (_req, res) => {
  const config = getChelCoachConfig();
  if (!config.auth.allowSessionMint) {
    res.status(503).json({
      error: "SESSION_MINT_DISABLED",
      message:
        "Development session minting is disabled. Production authentication is not ready.",
      retryable: false,
    });
    return;
  }
  try {
    const session = createOwnerSession();
    res.status(201).json({
      token: session.token,
      ownerId: session.ownerId,
      createdAt: session.createdAt,
      expiresAt: session.expiresAt,
    });
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "SESSION_MINT_DISABLED") {
      res.status(503).json({
        error: "SESSION_MINT_DISABLED",
        message: "Development session minting is disabled.",
        retryable: false,
      });
      return;
    }
    throw err;
  }
});

/** POST /api/session/logout — revoke the current bearer session. */
sessionRouter.post("/session/logout", (req, res) => {
  const token = extractBearerToken(req);
  if (!token) {
    res.status(401).json({ error: "UNAUTHORIZED", message: "Sign in required.", retryable: false });
    return;
  }
  logoutSession(token);
  res.status(204).end();
});

/** POST /api/session/rotate — issue a new token for the same owner (fixation mitigation). */
sessionRouter.post("/session/rotate", (req, res) => {
  const token = extractBearerToken(req);
  if (!token) {
    res.status(401).json({ error: "UNAUTHORIZED", message: "Sign in required.", retryable: false });
    return;
  }
  const next = rotateSession(token);
  if (!next) {
    res.status(401).json({
      error: "UNAUTHORIZED",
      message: "Invalid or expired session.",
      retryable: false,
    });
    return;
  }
  res.status(200).json({
    token: next.token,
    ownerId: next.ownerId,
    createdAt: next.createdAt,
    expiresAt: next.expiresAt,
  });
});
