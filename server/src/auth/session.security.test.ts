import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import express from "express";
import {
  createOwnerSession,
  resetSessionsForTests,
  rotateSession,
  revokeSession,
  getSessionByToken,
} from "./session";
import { resetChelCoachConfigCacheForTests } from "../config/chelcoachConfig";
import { sessionRouter } from "../routes/session";

describe("session auth production gates (Step 10 Option B)", () => {
  beforeEach(() => {
    resetSessionsForTests();
    resetChelCoachConfigCacheForTests();
  });

  it("blocks session mint when production auth not ready", async () => {
    process.env.NODE_ENV = "production";
    process.env.CHELCOACH_AUTH_MODE = "development_session";
    process.env.CHELCOACH_PRODUCTION_AUTH_READY = "false";
    process.env.CORS_ORIGIN = "https://app.example.com";
    process.env.CHELCOACH_LEGACY_UPLOAD_ENABLED = "false";
    process.env.CHELCOACH_ANALYSIS_PROVIDER = "scotty";
    process.env.CHELCOACH_SCOTTIE_ENABLED = "true";
    process.env.SCOTTY_BASE_URL = "https://scotty.example";
    process.env.SCOTTY_SIGNING_SECRET = "production-signing-secret-value";
    resetChelCoachConfigCacheForTests();

    const app = express();
    app.use(express.json());
    app.use("/api", sessionRouter);
    const server = app.listen(0);
    const port = (server.address() as { port: number }).port;
    const res = await fetch(`http://127.0.0.1:${port}/api/session`, { method: "POST" });
    assert.equal(res.status, 503);
    const body = (await res.json()) as { error: string };
    assert.equal(body.error, "SESSION_MINT_DISABLED");
    await new Promise<void>((resolve) => server.close(() => resolve()));

    // restore test env
    process.env.NODE_ENV = "test";
    delete process.env.CORS_ORIGIN;
    resetChelCoachConfigCacheForTests();
  });

  it("rotates tokens and rejects old token (session fixation mitigation)", () => {
    process.env.NODE_ENV = "test";
    resetChelCoachConfigCacheForTests();
    const session = createOwnerSession();
    const rotated = rotateSession(session.token);
    assert.ok(rotated);
    assert.notEqual(rotated.token, session.token);
    assert.equal(rotated.ownerId, session.ownerId);
    assert.equal(getSessionByToken(session.token), undefined);
    assert.ok(getSessionByToken(rotated.token));
  });

  it("logout revokes session", () => {
    process.env.NODE_ENV = "test";
    resetChelCoachConfigCacheForTests();
    const session = createOwnerSession();
    assert.equal(revokeSession(session.token), true);
    assert.equal(getSessionByToken(session.token), undefined);
  });
});
