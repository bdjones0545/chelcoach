/**
 * Browser security headers + CSP for ChelCoach API responses.
 */
import type { NextFunction, Request, Response } from "express";

/** Production-compatible CSP — Scotty/Anthropic are server-to-server only. */
export function contentSecurityPolicy(): string {
  return [
    "default-src 'none'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'self'",
  ].join("; ");
}

export function securityHeadersMiddleware(req: Request, res: Response, next: NextFunction): void {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader(
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=(), payment=()",
  );
  res.setHeader("Content-Security-Policy", contentSecurityPolicy());
  if (process.env.NODE_ENV === "production") {
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }

  // Authenticated / private API responses must not be publicly cached.
  if (req.path.startsWith("/api/")) {
    res.setHeader("Cache-Control", "no-store, private");
    res.setHeader("Pragma", "no-cache");
  }
  next();
}
