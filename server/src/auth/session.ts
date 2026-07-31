/**
 * Minimal pseudonymous session auth for upload ownership (Step 2).
 * Not full product auth — mints opaque owner tokens until real accounts land.
 */
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";

export interface OwnerSession {
  token: string;
  ownerId: string;
  createdAt: string;
}

const sessions = new Map<string, OwnerSession>();

function tokenKey(token: string): string {
  return token;
}

export function createOwnerSession(): OwnerSession {
  const session: OwnerSession = {
    token: randomBytes(32).toString("base64url"),
    ownerId: `own_${randomUUID().replace(/-/g, "")}`,
    createdAt: new Date().toISOString(),
  };
  sessions.set(tokenKey(session.token), session);
  return session;
}

export function getSessionByToken(token: string): OwnerSession | undefined {
  return sessions.get(tokenKey(token));
}

export function resetSessionsForTests(): void {
  sessions.clear();
}

/** Seed a known session for tests. */
export function seedSessionForTests(session: OwnerSession): void {
  sessions.set(tokenKey(session.token), session);
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
