/**
 * CSRF / request-origin protection for state-changing browser endpoints.
 *
 * Auth model: Bearer token in Authorization header (not cookie-bound).
 * Cross-site form posts cannot set custom Authorization headers, so bearer
 * semantics already mitigate classic cookie CSRF.
 *
 * Additional browser controls:
 * - When CORS_ORIGIN is configured, reject disallowed Origin/Referer.
 * - Browsers may send `X-ChelCoach-Requested-With: chelcoach` (defense in depth).
 * - Requests without Origin (curl, Node tests, same-origin quirks) are not
 *   rejected solely for missing custom headers — authentication still applies.
 */
import type { NextFunction, Request, Response } from "express";
import { getChelCoachConfig } from "../config/chelcoachConfig";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function originAllowed(origin: string, allowed: string[]): boolean {
  return allowed.includes(origin);
}

export function csrfProtection(req: Request, res: Response, next: NextFunction): void {
  if (SAFE_METHODS.has(req.method)) {
    next();
    return;
  }

  // Internal routes use dedicated secrets — exclude from browser CSRF rules.
  if (req.path.startsWith("/api/internal/") || req.path.startsWith("/internal/")) {
    next();
    return;
  }

  const config = getChelCoachConfig();
  const origin = req.header("origin");
  const referer = req.header("referer");

  if (config.cors.allowedOrigins.length > 0) {
    if (origin) {
      if (!originAllowed(origin, config.cors.allowedOrigins)) {
        res.status(403).json({
          error: "CSRF_REJECTED",
          message: "Request origin is not allowed.",
          retryable: false,
        });
        return;
      }
      next();
      return;
    }
    if (referer) {
      try {
        const refOrigin = new URL(referer).origin;
        if (!originAllowed(refOrigin, config.cors.allowedOrigins)) {
          res.status(403).json({
            error: "CSRF_REJECTED",
            message: "Request origin is not allowed.",
            retryable: false,
          });
          return;
        }
      } catch {
        res.status(403).json({
          error: "CSRF_REJECTED",
          message: "Request origin is not allowed.",
          retryable: false,
        });
        return;
      }
    }
  }

  next();
}
