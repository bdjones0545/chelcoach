/**
 * Lightweight in-process rate limiter (Step 10 foundation).
 * Dimensions: IP, user, and route class. Not a distributed limiter —
 * sufficient to prevent accidental abuse before multi-instance Redis.
 */
import type { NextFunction, Request, Response } from "express";
import type { AuthedRequest } from "../auth/session";

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();

export interface RateLimitOptions {
  windowMs: number;
  max: number;
  key: (req: Request) => string;
  code?: string;
}

export function resetRateLimitForTests(): void {
  buckets.clear();
}

function hit(key: string, windowMs: number, max: number): { ok: boolean; retryAfterSec: number } {
  const now = Date.now();
  const cur = buckets.get(key);
  if (!cur || now >= cur.resetAt) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return { ok: true, retryAfterSec: 0 };
  }
  cur.count += 1;
  if (cur.count > max) {
    return { ok: false, retryAfterSec: Math.max(1, Math.ceil((cur.resetAt - now) / 1000)) };
  }
  return { ok: true, retryAfterSec: 0 };
}

export function rateLimit(options: RateLimitOptions) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const key = options.key(req);
    const result = hit(key, options.windowMs, options.max);
    if (!result.ok) {
      res.setHeader("Retry-After", String(result.retryAfterSec));
      res.status(429).json({
        error: options.code ?? "RATE_LIMITED",
        message: "Too many requests. Try again shortly.",
        retryable: true,
      });
      return;
    }
    next();
  };
}

function clientIp(req: Request): string {
  const xf = req.header("x-forwarded-for");
  if (xf) return xf.split(",")[0]!.trim();
  return req.ip || "unknown";
}

function ownerKey(req: Request): string {
  const owner = (req as AuthedRequest).ownerId;
  return owner || clientIp(req);
}

/** Presets for ChelCoach routes. */
export const limits = {
  sessionCreate: rateLimit({
    windowMs: 60_000,
    max: 20,
    key: (req) => `session:${clientIp(req)}`,
    code: "SESSION_RATE_LIMITED",
  }),
  uploadCreate: rateLimit({
    windowMs: 60_000,
    max: 30,
    key: (req) => `upload-create:${ownerKey(req)}`,
    code: "UPLOAD_RATE_LIMITED",
  }),
  uploadStream: rateLimit({
    windowMs: 60_000,
    max: 60,
    key: (req) => `upload-stream:${ownerKey(req)}`,
    code: "UPLOAD_STREAM_RATE_LIMITED",
  }),
  identification: rateLimit({
    windowMs: 60_000,
    max: 20,
    key: (req) => `identify:${ownerKey(req)}`,
    code: "IDENTIFICATION_RATE_LIMITED",
  }),
  analysisSubmit: rateLimit({
    windowMs: 60_000,
    max: 15,
    key: (req) => `analysis:${ownerKey(req)}`,
    code: "ANALYSIS_RATE_LIMITED",
  }),
  confirmation: rateLimit({
    windowMs: 60_000,
    max: 30,
    key: (req) => `confirm:${ownerKey(req)}`,
    code: "CONFIRMATION_RATE_LIMITED",
  }),
  cancellation: rateLimit({
    windowMs: 60_000,
    max: 30,
    key: (req) => `cancel:${ownerKey(req)}`,
    code: "CANCEL_RATE_LIMITED",
  }),
  statusRead: rateLimit({
    windowMs: 60_000,
    max: 300,
    key: (req) => `status:${ownerKey(req)}`,
    code: "STATUS_RATE_LIMITED",
  }),
  reportRead: rateLimit({
    windowMs: 60_000,
    max: 120,
    key: (req) => `report:${ownerKey(req)}`,
    code: "REPORT_RATE_LIMITED",
  }),
  internal: rateLimit({
    windowMs: 60_000,
    max: 60,
    key: (req) => `internal:${clientIp(req)}`,
    code: "INTERNAL_RATE_LIMITED",
  }),
};
