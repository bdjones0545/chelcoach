/**
 * Ownership regression with Supabase UUID-shaped owner IDs (fixture auth).
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import express from "express";
import { profileRouter } from "../routes/profile";
import {
  resetChelCoachConfigCacheForTests,
} from "../config/chelcoachConfig";
import {
  resetProductionAuthForTests,
  setProductionAuthProviderForTests,
} from "./productionAuth";
import { createFixtureAuthProvider } from "./supabaseAuthProvider";
import { resetSessionsForTests } from "./session";
import { InMemoryProfileRepository, setProfileRepositoryForTests } from "../profile/repository";

const USER_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const USER_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

describe("supabase UUID ownership (fixture)", () => {
  beforeEach(() => {
    resetSessionsForTests();
    resetProductionAuthForTests();
    resetChelCoachConfigCacheForTests();
    setProfileRepositoryForTests(new InMemoryProfileRepository());
    process.env.CHELCOACH_AUTH_MODE = "supabase_auth";
    process.env.SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_ANON_KEY = "test-anon-key-value-long";
    process.env.NODE_ENV = "test";
    resetChelCoachConfigCacheForTests();
    setProductionAuthProviderForTests(
      createFixtureAuthProvider((token) => {
        if (token === "token-a") return { userId: USER_A, authProvider: "supabase" };
        if (token === "token-b") return { userId: USER_B, authProvider: "supabase" };
        return null;
      }),
    );
  });

  afterEach(() => {
    resetProductionAuthForTests();
    resetChelCoachConfigCacheForTests();
    delete process.env.CHELCOACH_AUTH_MODE;
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_ANON_KEY;
  });

  it("user A profile is not visible as user B identity", async () => {
    const app = express();
    app.use(express.json());
    app.use("/api", profileRouter);
    const server = app.listen(0);
    const port = (server.address() as { port: number }).port;

    const putA = await fetch(`http://127.0.0.1:${port}/api/gameplay-profile`, {
      method: "PUT",
      headers: {
        authorization: "Bearer token-a",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        preferredPlatform: "xbox_series",
        preferredControlScheme: "skill_stick",
        primaryPosition: "C",
        commonGameMode: "eashl",
      }),
    });
    assert.equal(putA.status, 200);
    const profileA = (await putA.json()) as { userId: string };
    assert.equal(profileA.userId, USER_A);

    const getB = await fetch(`http://127.0.0.1:${port}/api/gameplay-profile`, {
      headers: { authorization: "Bearer token-b" },
    });
    assert.equal(getB.status, 200);
    const profileB = (await getB.json()) as { userId: string };
    assert.equal(profileB.userId, USER_B);
    assert.notEqual(profileB.userId, USER_A);

    const missing = await fetch(`http://127.0.0.1:${port}/api/gameplay-profile`, {
      headers: { authorization: "Bearer token-evil" },
    });
    assert.equal(missing.status, 401);

    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});
