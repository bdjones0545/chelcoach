import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";
import {
  createFixtureAuthProvider,
  resetSupabaseAuthClientForTests,
} from "./supabaseAuthProvider";
import { AuthFailure } from "./types";
import {
  requireOwnerAuth,
  resetSessionsForTests,
  seedSessionForTests,
  type AuthedRequest,
} from "./session";
import {
  resetProductionAuthForTests,
  setProductionAuthProviderForTests,
} from "./productionAuth";
import {
  loadChelCoachConfig,
  resetChelCoachConfigCacheForTests,
} from "../config/chelcoachConfig";
import type { Request, Response, NextFunction } from "express";

function mockRes() {
  const state: { statusCode?: number; body?: unknown } = {};
  const res = {
    status(code: number) {
      state.statusCode = code;
      return this;
    },
    json(body: unknown) {
      state.body = body;
      return this;
    },
  } as unknown as Response;
  return { res, state };
}

describe("Supabase auth provider (Step 10.1B)", () => {
  beforeEach(() => {
    resetSessionsForTests();
    resetProductionAuthForTests();
    resetSupabaseAuthClientForTests();
    resetChelCoachConfigCacheForTests();
  });

  afterEach(() => {
    resetProductionAuthForTests();
    resetChelCoachConfigCacheForTests();
    delete process.env.CHELCOACH_AUTH_MODE;
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_ANON_KEY;
  });

  it("accepts a valid fixture token and derives userId", async () => {
    const userId = "550e8400-e29b-41d4-a716-446655440000";
    const provider = createFixtureAuthProvider((token) =>
      token === "valid.jwt.token"
        ? { userId, email: "a@example.com", authProvider: "supabase" }
        : null,
    );
    const user = await provider.authenticate({
      authorizationHeader: "Bearer valid.jwt.token",
    });
    assert.equal(user.userId, userId);
    assert.equal(user.authProvider, "supabase");
  });

  it("rejects missing token", async () => {
    const provider = createFixtureAuthProvider(() => null);
    await assert.rejects(
      () => provider.authenticate({}),
      (err: unknown) => err instanceof AuthFailure && err.code === "AUTHENTICATION_REQUIRED",
    );
  });

  it("rejects malformed bearer header", async () => {
    const provider = createFixtureAuthProvider(() => null);
    await assert.rejects(
      () => provider.authenticate({ authorizationHeader: "Token abc" }),
      (err: unknown) => err instanceof AuthFailure && err.code === "AUTHENTICATION_REQUIRED",
    );
  });

  it("rejects invalid token", async () => {
    const provider = createFixtureAuthProvider(() => null);
    await assert.rejects(
      () => provider.authenticate({ authorizationHeader: "Bearer not.a.valid" }),
      (err: unknown) => err instanceof AuthFailure && err.code === "INVALID_SESSION",
    );
  });

  it("rejects expired token via AuthFailure", async () => {
    const provider = createFixtureAuthProvider(
      () => new AuthFailure("SESSION_EXPIRED", "Sign in required."),
    );
    await assert.rejects(
      () => provider.authenticate({ authorizationHeader: "Bearer expired.jwt.token" }),
      (err: unknown) => err instanceof AuthFailure && err.code === "SESSION_EXPIRED",
    );
  });

  it("middleware uses supabase provider and ignores development Map", async () => {
    process.env.CHELCOACH_AUTH_MODE = "supabase_auth";
    process.env.SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_ANON_KEY = "test-anon-key-value-long";
    resetChelCoachConfigCacheForTests();
    loadChelCoachConfig(process.env);

    const userId = "11111111-2222-3333-4444-555555555555";
    setProductionAuthProviderForTests(
      createFixtureAuthProvider((token) =>
        token === "supa.access.token"
          ? { userId, authProvider: "supabase" }
          : null,
      ),
    );

    // Seed a development session that must NOT be used.
    seedSessionForTests({
      token: "dev-token",
      ownerId: "own_should_not_win",
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });

    const { res, state } = mockRes();
    let nextCalled = false;
    const req = {
      header(name: string) {
        if (name.toLowerCase() === "authorization") return "Bearer supa.access.token";
        return undefined;
      },
    } as unknown as Request;

    await new Promise<void>((resolve) => {
      requireOwnerAuth(req, res, (() => {
        nextCalled = true;
        resolve();
      }) as NextFunction);
      // allow async path
      setTimeout(() => resolve(), 50);
    });

    assert.equal(nextCalled, true);
    assert.equal((req as AuthedRequest).ownerId, userId);
    assert.equal((req as AuthedRequest).authProvider, "supabase");
    assert.equal(state.statusCode, undefined);
  });

  it("does not fall back to development session when supabase token invalid", async () => {
    process.env.CHELCOACH_AUTH_MODE = "supabase_auth";
    process.env.SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_ANON_KEY = "test-anon-key-value-long";
    resetChelCoachConfigCacheForTests();
    loadChelCoachConfig(process.env);

    setProductionAuthProviderForTests(createFixtureAuthProvider(() => null));
    seedSessionForTests({
      token: "dev-token",
      ownerId: "own_fallback",
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });

    const { res, state } = mockRes();
    const req = {
      header(name: string) {
        if (name.toLowerCase() === "authorization") return "Bearer dev-token";
        return undefined;
      },
    } as unknown as Request;

    await new Promise<void>((resolve) => {
      requireOwnerAuth(req, res, (() => resolve()) as NextFunction);
      setTimeout(resolve, 50);
    });

    assert.equal(state.statusCode, 401);
    assert.equal((state.body as { error: string }).error, "INVALID_SESSION");
  });

  it("auth errors do not include token claims", async () => {
    const provider = createFixtureAuthProvider(
      () => new AuthFailure("INVALID_SESSION", "Sign in required."),
    );
    try {
      await provider.authenticate({
        authorizationHeader: "Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig",
      });
      assert.fail("expected throw");
    } catch (err) {
      assert.ok(err instanceof AuthFailure);
      assert.ok(!err.message.includes("eyJ"));
      assert.ok(!JSON.stringify(err).includes("payload"));
    }
  });
});
