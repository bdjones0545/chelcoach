/**
 * Owner authentication middleware (Step 10 / 10.1B).
 *
 * Modes:
 * - development_session: opaque in-memory bearer tokens (local / E2E only)
 * - supabase_auth: Bearer Supabase access token → verified user UUID as ownerId
 * - disabled: all authed routes return 503
 *
 * The browser must never submit its own ownerId — ownership is derived only here.
 */
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { getChelCoachConfig } from "../config/chelcoachConfig";
import { getProductionAuthProvider, isSupabaseAuthMode } from "./productionAuth";
import { AuthFailure } from "./types";

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
  authProvider?: "supabase" | "development_session";
}

function sendAuthError(res: Response, failure: AuthFailure): void {
  const status =
    failure.code === "AUTH_DISABLED"
      ? 503
      : failure.code === "AUTH_PROVIDER_UNAVAILABLE"
        ? 503
        : 401;
  res.status(status).json({
    error: failure.code,
    message: failure.message,
    retryable: failure.retryable,
  });
}

/**
 * Require a trusted owner identity.
 * - development_session: opaque Map token
 * - supabase_auth: verified Supabase access token → user.id
 * Never falls back across modes.
 */
export function requireOwnerAuth(req: Request, res: Response, next: NextFunction): void {
  const config = getChelCoachConfig();
  if (config.auth.mode === "disabled") {
    sendAuthError(res, new AuthFailure("AUTH_DISABLED", "Authentication is disabled."));
    return;
  }

  if (isSupabaseAuthMode(config)) {
    void (async () => {
      try {
        const provider = getProductionAuthProvider(config);
        const user = await provider.authenticate({
          authorizationHeader: req.header("authorization") ?? undefined,
        });
        (req as AuthedRequest).ownerId = user.userId;
        (req as AuthedRequest).ownerToken = extractBearerToken(req) ?? "";
        (req as AuthedRequest).authProvider = "supabase";
        next();
      } catch (err) {
        if (err instanceof AuthFailure) {
          sendAuthError(res, err);
          return;
        }
        sendAuthError(
          res,
          new AuthFailure("AUTH_PROVIDER_UNAVAILABLE", "Authentication temporarily unavailable.", true),
        );
      }
    })();
    return;
  }

  // development_session (and legacy existing_auth without supabase provider — rejected at config)
  if (config.auth.mode !== "development_session") {
    sendAuthError(
      res,
      new AuthFailure("AUTH_PROVIDER_UNAVAILABLE", "Authentication is not configured.", false),
    );
    return;
  }

  const token = extractBearerToken(req);
  if (!token) {
    sendAuthError(res, new AuthFailure("AUTHENTICATION_REQUIRED", "Sign in required."));
    return;
  }
  const session = getSessionByToken(token);
  if (!session) {
    sendAuthError(res, new AuthFailure("INVALID_SESSION", "Invalid or expired session."));
    return;
  }
  (req as AuthedRequest).ownerId = session.ownerId;
  (req as AuthedRequest).ownerToken = session.token;
  (req as AuthedRequest).authProvider = "development_session";
  next();
}

export function assertOwner(ownerId: string, resourceOwnerId: string): boolean {
  const a = Buffer.from(ownerId);
  const b = Buffer.from(resourceOwnerId);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Logout — revoke current opaque bearer session (development_session only). */
export function logoutSession(token: string): boolean {
  return revokeSession(token);
}
