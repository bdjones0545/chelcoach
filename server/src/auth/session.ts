/**
 * Pseudonymous session auth (development / test only).
 *
 * Authentication decision (Step 10 — Option B):
 * No production authentication system exists yet. Development sessions are
 * blocked in production by default via CHELCOACH_AUTH_MODE + readiness gates.
 * Do not treat browser-generated ownership as production authentication.
 */
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { getChelCoachConfig } from "../config/chelcoachConfig";

export interface OwnerSession {
  token: string;
  ownerId: string;
  createdAt: string;
  expiresAt: string;
  revokedAt?: string;
}

const sessions = new Map<string, OwnerSession>();

function tokenKey(token: string): string {
  return token;
}

export function createOwnerSession(ttlMs?: number): OwnerSession {
  const config = getChelCoachConfig();
  if (!config.auth.allowSessionMint) {
    throw Object.assign(new Error("SESSION_MINT_DISABLED"), { code: "SESSION_MINT_DISABLED" });
  }
  const ttl = ttlMs ?? config.auth.sessionTtlMs;
  const now = Date.now();
  const session: OwnerSession = {
    token: randomBytes(32).toString("base64url"),
    ownerId: `own_${randomUUID().replace(/-/g, "")}`,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + ttl).toISOString(),
  };
  sessions.set(tokenKey(session.token), session);
  return session;
}

export function getSessionByToken(token: string, now: Date = new Date()): OwnerSession | undefined {
  const session = sessions.get(tokenKey(token));
  if (!session) return undefined;
  if (session.revokedAt) return undefined;
  if (now.getTime() >= new Date(session.expiresAt).getTime()) {
    sessions.delete(tokenKey(token));
    return undefined;
  }
  return session;
}

/** Rotate token value while preserving ownerId (mitigates fixation after privilege change). */
export function rotateSession(token: string): OwnerSession | undefined {
  const existing = getSessionByToken(token);
  if (!existing) return undefined;
  sessions.delete(tokenKey(token));
  const next: OwnerSession = {
    ...existing,
    token: randomBytes(32).toString("base64url"),
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + getChelCoachConfig().auth.sessionTtlMs).toISOString(),
  };
  sessions.set(tokenKey(next.token), next);
  return next;
}

export function resetSessionsForTests(): void {
  sessions.clear();
}

/** Revoke a single opaque session token (E2E / tests / logout). */
export function revokeSession(token: string): boolean {
  const session = sessions.get(tokenKey(token));
  if (!session) return false;
  session.revokedAt = new Date().toISOString();
  sessions.delete(tokenKey(token));
  return true;
}

/** Seed a known session for tests. */
export function seedSessionForTests(session: OwnerSession): void {
  const withExpiry: OwnerSession = {
    ...session,
    expiresAt:
      session.expiresAt ??
      new Date(Date.now() + getChelCoachConfig().auth.sessionTtlMs).toISOString(),
  };
  sessions.set(tokenKey(withExpiry.token), withExpiry);
}

export function extractBearerToken(req: Request): string | undefined {
  const header = req.header("authorization");
  if (header?.toLowerCase().startsWith("bearer ")) {
    return header.slice(7).trim();
  }
  const alt = req.header("x-chelcoach-owner-token");
  return alt?.trim() || undefined;
}

export interface AuthedRequest extends Request {
  ownerId: string;
  ownerToken: string;
}

export function requireOwnerAuth(req: Request, res: Response, next: NextFunction): void {
  const config = getChelCoachConfig();
  if (config.auth.mode === "disabled") {
    res.status(503).json({
      error: "AUTH_DISABLED",
      message: "Authentication is disabled.",
      retryable: false,
    });
    return;
  }

  const token = extractBearerToken(req);
  if (!token) {
    res.status(401).json({
      error: "UNAUTHORIZED",
      message: "Sign in required.",
      retryable: false,
    });
    return;
  }
  const session = getSessionByToken(token);
  if (!session) {
    res.status(401).json({
      error: "UNAUTHORIZED",
      message: "Invalid or expired session.",
      retryable: false,
    });
    return;
  }
  (req as AuthedRequest).ownerId = session.ownerId;
  (req as AuthedRequest).ownerToken = session.token;
  next();
}

export function assertOwner(ownerId: string, resourceOwnerId: string): boolean {
  const a = Buffer.from(ownerId);
  const b = Buffer.from(resourceOwnerId);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Logout — revoke current bearer session. */
export function logoutSession(token: string): boolean {
  return revokeSession(token);
}
