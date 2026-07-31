import assert from "node:assert/strict";
import { describe, it, beforeEach } from "node:test";
import express from "express";
import { createOwnerSession, resetSessionsForTests, revokeSession, getSessionByToken, seedSessionForTests } from "../auth/session";
import { resetChelCoachConfigCacheForTests } from "../config/chelcoachConfig";
import { csrfProtection } from "./csrf";
import { contentSecurityPolicy, securityHeadersMiddleware } from "./headers";
import { publicErrorMessage, redactValue, safeLogFields } from "./logging";
import { limits, resetRateLimitForTests } from "./rateLimit";
import { requireInternalSecret, safeEqualString } from "./secrets";
import { assertE2eNotEnabledInProduction, isE2eMode } from "../e2e/hooks";

describe("security helpers (Step 10)", () => {
  beforeEach(() => {
    resetSessionsForTests();
    resetRateLimitForTests();
    resetChelCoachConfigCacheForTests();
    process.env.NODE_ENV = "test";
    delete process.env.CORS_ORIGIN;
    delete process.env.CHELCOACH_E2E_MODE;
  });

  it("development session mint works; revoked/expired rejected", () => {
    const session = createOwnerSession(60_000);
    assert.ok(getSessionByToken(session.token));
    revokeSession(session.token);
    assert.equal(getSessionByToken(session.token), undefined);

    seedSessionForTests({
      token: "expired-token",
      ownerId: "own_x",
      createdAt: new Date(Date.now() - 10_000).toISOString(),
      expiresAt: new Date(Date.now() - 1_000).toISOString(),
    });
    assert.equal(getSessionByToken("expired-token"), undefined);
  });

  it("constant-time secret compare rejects mismatches", () => {
    assert.equal(safeEqualString("abc", "abc"), true);
    assert.equal(safeEqualString("abc", "abd"), false);
    assert.equal(requireInternalSecret("x", ""), false);
    assert.equal(requireInternalSecret("secret", "secret"), false); // placeholder
    assert.equal(requireInternalSecret("real-secret-value", "real-secret-value"), true);
  });

  it("E2E mode impossible in production", () => {
    assert.throws(
      () => assertE2eNotEnabledInProduction({ NODE_ENV: "production", CHELCOACH_E2E_MODE: "1" }),
      /cannot be enabled/,
    );
    process.env.NODE_ENV = "production";
    process.env.CHELCOACH_E2E_MODE = "1";
    assert.equal(isE2eMode(), false);
  });

  it("redacts secrets from logs and public errors", () => {
    assert.equal(redactValue("authorization", "Bearer abc"), "[REDACTED]");
    assert.equal(redactValue("SCOTTY_SIGNING_SECRET", "xyz"), "[REDACTED]");
    const fields = safeLogFields({ authorization: "Bearer x", uploadId: "u1" });
    assert.equal(fields.authorization, "[REDACTED]");
    assert.equal(fields.uploadId, "u1");
    assert.equal(
      publicErrorMessage(new Error("password authentication failed for user")),
      "Unexpected error.",
    );
    assert.match(publicErrorMessage(new Error("UPLOAD_NOT_FOUND")), /UPLOAD_NOT_FOUND/);
  });

  it("CSP excludes Scotty origins", () => {
    const csp = contentSecurityPolicy();
    assert.ok(!csp.includes("scotty"));
    assert.ok(csp.includes("default-src 'none'"));
    assert.ok(csp.includes("frame-ancestors 'none'"));
  });

  it("security headers set no-store on API paths", async () => {
    const app = express();
    app.use(securityHeadersMiddleware);
    app.get("/api/analysis/x", (_req, res) => res.json({ ok: true }));
    const server = app.listen(0);
    const port = (server.address() as { port: number }).port;
    const res = await fetch(`http://127.0.0.1:${port}/api/analysis/x`);
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    assert.equal(res.headers.get("x-frame-options"), "DENY");
    assert.match(res.headers.get("cache-control") ?? "", /no-store/);
    assert.match(res.headers.get("content-security-policy") ?? "", /default-src/);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("CSRF rejects hostile Origin when allow-list is set", async () => {
    process.env.CORS_ORIGIN = "https://app.example.com";
    resetChelCoachConfigCacheForTests();
    const app = express();
    app.use(express.json());
    app.use(csrfProtection);
    app.post("/api/uploads", (_req, res) => res.json({ ok: true }));
    const server = app.listen(0);
    const port = (server.address() as { port: number }).port;
    const bad = await fetch(`http://127.0.0.1:${port}/api/uploads`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://evil.example",
        authorization: "Bearer tok",
      },
      body: "{}",
    });
    assert.equal(bad.status, 403);
    const good = await fetch(`http://127.0.0.1:${port}/api/uploads`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://app.example.com",
        authorization: "Bearer tok",
      },
      body: "{}",
    });
    assert.equal(good.status, 200);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("rate limits session creation", async () => {
    const app = express();
    app.post("/api/session", limits.sessionCreate, (_req, res) => res.status(201).json({ ok: true }));
    const server = app.listen(0);
    const port = (server.address() as { port: number }).port;
    let last = 201;
    for (let i = 0; i < 25; i++) {
      const res = await fetch(`http://127.0.0.1:${port}/api/session`, { method: "POST" });
      last = res.status;
    }
    assert.equal(last, 429);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});
