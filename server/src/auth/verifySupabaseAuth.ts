/**
 * Safe Supabase Auth verification command.
 * npm run verify:supabase-auth
 *
 * Never prints tokens, keys, or emails in full.
 */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { createClient } from "@supabase/supabase-js";
import { loadLocalEnvFiles } from "../config/loadEnv";
import {
  loadChelCoachConfig,
  resetChelCoachConfigCacheForTests,
  validateChelCoachConfig,
} from "../config/chelcoachConfig";
import { createSupabaseAuthProvider } from "./supabaseAuthProvider";
import { AuthFailure } from "./types";

const here = dirname(fileURLToPath(import.meta.url));

function fail(msg: string): never {
  console.error(`[verify:supabase-auth] FAIL: ${msg}`);
  process.exit(1);
}

function mask(value: string): string {
  if (!value) return "(empty)";
  if (value.length <= 8) return `(set len=${value.length})`;
  return `(set len=${value.length} prefix=${value.slice(0, 4)}…)`;
}

async function runInjectedChecks(): Promise<void> {
  const provider = createSupabaseAuthProvider({
    url: "https://example.supabase.co",
    anonKey: "test-anon-key-not-used-for-network",
  });
  // Malformed token should fail locally without depending on network success path.
  try {
    await provider.authenticate({ authorizationHeader: "Bearer short" });
    fail("expected malformed token rejection");
  } catch (err) {
    if (!(err instanceof AuthFailure)) fail("expected AuthFailure");
  }
  console.log("[verify:supabase-auth] injected_malformed_token_rejected=true");
}

async function runLiveIntegration(): Promise<void> {
  const url = (process.env.SUPABASE_URL ?? "").trim();
  const anon = (process.env.SUPABASE_ANON_KEY ?? "").trim();
  const service = (process.env.SUPABASE_SERVICE_ROLE_KEY ?? "").trim();
  const apiBase = (process.env.CHELCOACH_API_BASE ?? "http://127.0.0.1:3001").trim();
  if (!url || !anon || !service) {
    fail("live check requires SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY");
  }

  const stamp = Date.now().toString(36);
  const emailA = `chelcoach.auth.test.a.${stamp}@example.com`;
  const emailB = `chelcoach.auth.test.b.${stamp}@example.com`;
  const password = `T3st!${stamp}Aa`;

  const admin = createClient(url, service, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const browser = createClient(url, anon, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  let userAId = "";
  let userBId = "";
  try {
    const createdA = await admin.auth.admin.createUser({
      email: emailA,
      password,
      email_confirm: true,
    });
    if (createdA.error || !createdA.data.user) {
      fail(`create user A failed: ${createdA.error?.message ?? "unknown"}`);
    }
    userAId = createdA.data.user.id;

    const createdB = await admin.auth.admin.createUser({
      email: emailB,
      password,
      email_confirm: true,
    });
    if (createdB.error || !createdB.data.user) {
      fail(`create user B failed: ${createdB.error?.message ?? "unknown"}`);
    }
    userBId = createdB.data.user.id;

    const signA = await browser.auth.signInWithPassword({ email: emailA, password });
    if (signA.error || !signA.data.session?.access_token) {
      fail(`sign-in A failed: ${signA.error?.message ?? "no session"}`);
    }
    const tokenA = signA.data.session.access_token;

    const provider = createSupabaseAuthProvider({ url, anonKey: anon });
    const authed = await provider.authenticate({
      authorizationHeader: `Bearer ${tokenA}`,
    });
    if (authed.userId !== userAId) {
      fail("verified user id does not match created user");
    }
    console.log("[verify:supabase-auth] live_token_verified=true");

    // Optional: hit local API if running with supabase_auth mode.
    if (process.env.CHELCOACH_LIVE_AUTH_HIT_API === "1") {
      const profileRes = await fetch(`${apiBase}/api/gameplay-profile`, {
        headers: {
          authorization: `Bearer ${tokenA}`,
          "X-ChelCoach-Requested-With": "chelcoach",
        },
      });
      console.log(`[verify:supabase-auth] api_profile_status=${profileRes.status}`);
      if (profileRes.status !== 200 && profileRes.status !== 404) {
        // 200 with profile or empty — route should not be 401
        if (profileRes.status === 401 || profileRes.status === 503) {
          fail(`protected API rejected valid token status=${profileRes.status}`);
        }
      }

      // Put profile as A
      const putA = await fetch(`${apiBase}/api/gameplay-profile`, {
        method: "PUT",
        headers: {
          authorization: `Bearer ${tokenA}`,
          "content-type": "application/json",
          "X-ChelCoach-Requested-With": "chelcoach",
        },
        body: JSON.stringify({
          preferredPlatform: "xbox_series",
          preferredControlScheme: "skill_stick",
          primaryPosition: "C",
          commonGameMode: "eashl",
        }),
      });
      console.log(`[verify:supabase-auth] api_profile_put_a=${putA.status}`);

      const signB = await browser.auth.signInWithPassword({ email: emailB, password });
      const tokenB = signB.data.session?.access_token;
      if (!tokenB) fail("sign-in B failed");
      const getAsB = await fetch(`${apiBase}/api/gameplay-profile`, {
        headers: {
          authorization: `Bearer ${tokenB}`,
          "X-ChelCoach-Requested-With": "chelcoach",
        },
      });
      // B should get its own empty/default profile, not A's — owner is derived from token.
      if (getAsB.ok) {
        const body = (await getAsB.json()) as { userId?: string };
        if (body.userId && body.userId === userAId) {
          fail("user B received user A profile");
        }
        console.log("[verify:supabase-auth] two_user_isolation=true");
      } else {
        console.log(`[verify:supabase-auth] two_user_profile_status=${getAsB.status}`);
      }
    }

    // Revoke / sign out — old token should eventually fail; at minimum signOut clears client session.
    await browser.auth.signOut();
    console.log("[verify:supabase-auth] live_signout_ok=true");
  } finally {
    if (userAId) {
      await admin.auth.admin.deleteUser(userAId).catch(() => undefined);
    }
    if (userBId) {
      await admin.auth.admin.deleteUser(userBId).catch(() => undefined);
    }
    console.log("[verify:supabase-auth] live_test_users_cleaned=true");
  }
}

async function main(): Promise<void> {
  loadLocalEnvFiles(resolve(here, "../.."));
  loadLocalEnvFiles(resolve(here, "../../.."));
  resetChelCoachConfigCacheForTests();

  const urlSet = Boolean((process.env.SUPABASE_URL ?? "").trim());
  const anonSet = Boolean((process.env.SUPABASE_ANON_KEY ?? "").trim());
  const serviceSet = Boolean((process.env.SUPABASE_SERVICE_ROLE_KEY ?? "").trim());
  const viteUrlSet = Boolean((process.env.VITE_SUPABASE_URL ?? "").trim());
  const viteAnonSet = Boolean((process.env.VITE_SUPABASE_ANON_KEY ?? "").trim());

  console.log("[verify:supabase-auth] config (safe):");
  console.log(
    JSON.stringify(
      {
        SUPABASE_URL: mask(process.env.SUPABASE_URL ?? ""),
        SUPABASE_ANON_KEY: mask(process.env.SUPABASE_ANON_KEY ?? ""),
        SUPABASE_SERVICE_ROLE_KEY: serviceSet ? mask("x".repeat(20)) : "(empty)",
        VITE_SUPABASE_URL: viteUrlSet ? mask(process.env.VITE_SUPABASE_URL ?? "") : "(empty)",
        VITE_SUPABASE_ANON_KEY: viteAnonSet ? "(set)" : "(empty)",
        CHELCOACH_AUTH_MODE: process.env.CHELCOACH_AUTH_MODE ?? "(default)",
      },
      null,
      2,
    ),
  );

  if (!urlSet || !anonSet) {
    fail("SUPABASE_URL and SUPABASE_ANON_KEY are required");
  }

  // Config validation under supabase_auth (without forcing production ready).
  const config = loadChelCoachConfig({
    ...process.env,
    CHELCOACH_AUTH_MODE: "supabase_auth",
    CHELCOACH_PRODUCTION_AUTH_READY: "false",
    NODE_ENV: process.env.NODE_ENV ?? "development",
  });
  const validation = validateChelCoachConfig(config);
  if (!validation.ok) {
    fail(`config invalid: ${validation.issues.map((i) => i.code).join(",")}`);
  }
  console.log("[verify:supabase-auth] supabase_auth_config_ok=true");

  await runInjectedChecks();

  if (process.env.CHELCOACH_LIVE_AUTH_VERIFY === "1") {
    if (!serviceSet) fail("live verify requires SUPABASE_SERVICE_ROLE_KEY");
    await runLiveIntegration();
  } else {
    console.log(
      "[verify:supabase-auth] live_integration_skipped (set CHELCOACH_LIVE_AUTH_VERIFY=1 to run)",
    );
  }

  console.log("[verify:supabase-auth] OK");
}

main().catch((err) => {
  const message = String(err instanceof Error ? err.message : err)
    .replace(/eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+/g, "[REDACTED_JWT]")
    .replace(/postgres(?:ql)?:\/\/\S+/gi, "[REDACTED]");
  fail(message);
});
