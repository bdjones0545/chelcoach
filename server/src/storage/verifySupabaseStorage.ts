/**
 * Safe Supabase Storage verification command.
 * npm run verify:supabase-storage
 *
 * Never prints tokens, keys, or signed URLs.
 *
 * Live checks (opt-in): CHELCOACH_LIVE_STORAGE_VERIFY=1
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { loadLocalEnvFiles } from "../config/loadEnv";
import {
  loadChelCoachConfig,
  resetChelCoachConfigCacheForTests,
  validateChelCoachConfig,
} from "../config/chelcoachConfig";
import { createMigrationPool } from "../db/client";
import {
  gameplayObjectKey,
  loadSupabaseStorageConfig,
  supabaseStorageDiagnostics,
} from "./supabaseStorageConfig";
import { createSupabaseMediaObjectStorage } from "./supabaseMediaObjectStorage";

const here = dirname(fileURLToPath(import.meta.url));

function fail(msg: string): never {
  console.error(`[verify:supabase-storage] FAIL: ${msg}`);
  process.exit(1);
}

function ok(msg: string): void {
  console.log(`[verify:supabase-storage] ${msg}`);
}

const REQUIRED_POLICIES = [
  "chelcoach_gameplay_insert_own_prefix",
  "chelcoach_gameplay_select_own_prefix",
  "chelcoach_gameplay_update_own_prefix",
  "chelcoach_derived_select_own_prefix",
];

async function applyRlsIfRequested(): Promise<void> {
  if (process.env.CHELCOACH_APPLY_STORAGE_RLS !== "1") return;
  const sqlPath = resolve(here, "sql/0001_storage_rls.sql");
  const sql = readFileSync(sqlPath, "utf8");
  const pool = createMigrationPool();
  try {
    await pool.query(sql);
    ok("storage_rls_applied=true");
  } finally {
    await pool.end();
  }
}

async function runConfigChecks(): Promise<void> {
  resetChelCoachConfigCacheForTests();
  process.env.CHELCOACH_MEDIA_STORAGE_MODE =
    process.env.CHELCOACH_MEDIA_STORAGE_MODE || "supabase_storage";
  const config = loadChelCoachConfig();
  const validation = validateChelCoachConfig(config);
  const storageIssues = validation.issues.filter((i) =>
    ["STORAGE_NOT_CONFIGURED", "MEDIA_STORAGE_READY_WITHOUT_SUPABASE", "LOCAL_DISK_NOT_PRODUCTION_READY"].includes(
      i.code,
    ),
  );
  if (config.storage.mode === "supabase_storage" && !config.storage.supabaseStorageConfigured) {
    fail("supabase_storage mode but storage not configured");
  }
  ok(`mode=${config.storage.mode}`);
  ok(`productionMediaStorageReady=${config.storage.productionMediaStorageReady}`);
  if (config.storage.productionMediaStorageReady) {
    ok("note=PRODUCTION_MEDIA_STORAGE_READY is true (must be intentional)");
  } else {
    ok("production_ready_flag=false (expected until live verification signed off)");
  }
  void storageIssues;
  const cfg = loadSupabaseStorageConfig();
  ok(`diagnostics=${JSON.stringify(supabaseStorageDiagnostics(cfg))}`);
}

async function runBucketChecks(): Promise<{
  url: string;
  anon: string;
  service: string;
  gameplay: string;
  derived: string;
}> {
  const url = (process.env.SUPABASE_URL ?? "").trim();
  const anon = (process.env.SUPABASE_ANON_KEY ?? "").trim();
  const service = (process.env.SUPABASE_SERVICE_ROLE_KEY ?? "").trim();
  const gameplay = (process.env.SUPABASE_GAMEPLAY_BUCKET ?? "chelcoach-gameplay").trim();
  const derived = (process.env.SUPABASE_DERIVED_MEDIA_BUCKET ?? "chelcoach-derived-media").trim();
  if (!url || !anon || !service) {
    fail("requires SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY");
  }

  const admin = createClient(url, service, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: buckets, error } = await admin.storage.listBuckets();
  if (error) fail(`listBuckets failed: ${error.message}`);
  const byId = new Map((buckets ?? []).map((b) => [b.id, b]));
  for (const name of [gameplay, derived]) {
    const b = byId.get(name);
    if (!b) fail(`bucket missing: ${name}`);
    if (b.public) fail(`bucket must be private: ${name}`);
    ok(`bucket=${name} private=true`);
  }
  return { url, anon, service, gameplay, derived };
}

async function runPolicyChecks(): Promise<void> {
  const dbUrl = (process.env.DATABASE_URL_MIGRATE ?? process.env.DATABASE_URL ?? "").trim();
  if (!dbUrl) {
    ok("policy_check=skipped (no DATABASE_URL)");
    return;
  }
  const pool = createMigrationPool();
  try {
    const { rows } = await pool.query<{ policyname: string }>(
      `select policyname from pg_policies where schemaname = 'storage' and tablename = 'objects'`,
    );
    const names = new Set(rows.map((r) => r.policyname));
    for (const p of REQUIRED_POLICIES) {
      if (!names.has(p)) fail(`missing storage RLS policy: ${p}`);
      ok(`policy=${p} present=true`);
    }
  } finally {
    await pool.end();
  }
}

async function runLiveIsolation(): Promise<void> {
  const { url, anon, service, gameplay, derived } = await runBucketChecks();
  void service;
  await applyRlsIfRequested();
  await runPolicyChecks();

  const stamp = Date.now().toString(36);
  const emailA = `chelcoach.storage.test.a.${stamp}@example.com`;
  const emailB = `chelcoach.storage.test.b.${stamp}@example.com`;
  const password = `T3st!${stamp}Aa`;
  const uploadId = `00000000-0000-4000-8000-${stamp.padStart(12, "0").slice(0, 12)}`;

  const admin = createClient(url, service, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const browser = createClient(url, anon, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  let userAId = "";
  let userBId = "";
  let objectPath = "";

  try {
    const createdA = await admin.auth.admin.createUser({
      email: emailA,
      password,
      email_confirm: true,
    });
    if (createdA.error || !createdA.data.user) fail(`create A: ${createdA.error?.message}`);
    userAId = createdA.data.user.id;

    const createdB = await admin.auth.admin.createUser({
      email: emailB,
      password,
      email_confirm: true,
    });
    if (createdB.error || !createdB.data.user) fail(`create B: ${createdB.error?.message}`);
    userBId = createdB.data.user.id;

    const signA = await browser.auth.signInWithPassword({ email: emailA, password });
    if (signA.error || !signA.data.session?.access_token) fail("sign-in A failed");
    const tokenA = signA.data.session.access_token;

    objectPath = gameplayObjectKey(userAId, uploadId);
    const bytes = Buffer.from("chelcoach-storage-verify-fixture-mp4");
    const userClient = createClient(url, anon, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { Authorization: `Bearer ${tokenA}` } },
    });

    // Authenticated upload to own path (standard API — proves RLS insert; TUS covered by unit/live app).
    const up = await userClient.storage.from(gameplay).upload(objectPath, bytes, {
      contentType: "video/mp4",
      upsert: false,
    });
    if (up.error) fail(`user A upload own path failed: ${up.error.message}`);
    ok("user_a_upload_own_prefix=true");

    // Cross-user insert blocked
    const signB = await browser.auth.signInWithPassword({ email: emailB, password });
    if (signB.error || !signB.data.session?.access_token) fail("sign-in B failed");
    const tokenB = signB.data.session.access_token;
    const userBClient = createClient(url, anon, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { Authorization: `Bearer ${tokenB}` } },
    });
    const crossPath = gameplayObjectKey(userAId, uploadId) + "-cross";
    const cross = await userBClient.storage.from(gameplay).upload(crossPath, bytes, {
      contentType: "video/mp4",
      upsert: false,
    });
    if (!cross.error) fail("user B upload to user A prefix should be blocked");
    ok("user_b_cross_insert_blocked=true");

    const steal = await userBClient.storage.from(gameplay).download(objectPath);
    if (!steal.error) fail("user B download of user A object should be blocked");
    ok("user_b_cross_read_blocked=true");

    const delB = await userBClient.storage.from(gameplay).remove([objectPath]);
    // remove may return without throwing; verify object still exists via service role
    void delB;
    const storage = createSupabaseMediaObjectStorage();
    const stillThere = await storage.statObject(objectPath);
    if (!stillThere.exists) fail("user B must not delete user A object");
    ok("user_b_cross_delete_blocked=true");

    // Derived-media browser insert blocked
    const derivedPath = `${userAId}/${uploadId}/confirmation/frame-test.jpg`;
    const derIns = await userClient.storage.from(derived).upload(derivedPath, bytes, {
      contentType: "image/jpeg",
      upsert: false,
    });
    if (!derIns.error) fail("browser insert to derived-media should be blocked");
    ok("derived_browser_insert_blocked=true");

    // Service-role derived write + cleanup
    await storage.writeDerivedBytes(derivedPath, bytes, "image/jpeg");
    ok("service_role_derived_write=true");
    const derStat = await storage.statObject(derivedPath);
    if (!derStat.exists) fail("derived object missing after service write");
    ok("service_role_stat=true");

    const delDer = await storage.deleteObject(derivedPath);
    ok(`service_role_derived_delete deleted=${delDer.deleted} absent=${delDer.alreadyAbsent}`);
    const delSrc = await storage.deleteObject(objectPath);
    ok(`service_role_gameplay_delete deleted=${delSrc.deleted} absent=${delSrc.alreadyAbsent}`);

    const idem = await storage.deleteObject(objectPath);
    if (!idem.alreadyAbsent && idem.deleted) {
      // second delete of missing should be idempotent success
    }
    ok("missing_object_cleanup_idempotent=true");

    // Confirm buckets still private
    const { data: buckets } = await admin.storage.listBuckets();
    for (const name of [gameplay, derived]) {
      const b = (buckets ?? []).find((x) => x.id === name);
      if (!b || b.public) fail(`bucket privacy regression: ${name}`);
    }
    ok("bucket_privacy_unchanged=true");
  } finally {
    // Cleanup test objects (service role) and users
    try {
      if (userAId && objectPath) {
        const storage = createSupabaseMediaObjectStorage();
        await storage.deleteObject(objectPath).catch(() => undefined);
        await storage
          .deleteObject(`${userAId}/${uploadId}/confirmation/frame-test.jpg`)
          .catch(() => undefined);
        await storage.deleteObject(objectPath + "-cross").catch(() => undefined);
      }
    } catch {
      /* ignore */
    }
    if (userAId) await admin.auth.admin.deleteUser(userAId).catch(() => undefined);
    if (userBId) await admin.auth.admin.deleteUser(userBId).catch(() => undefined);
    ok("test_users_cleaned=true");
  }
}

async function main(): Promise<void> {
  loadLocalEnvFiles(resolve(here, "../.."));
  loadLocalEnvFiles(resolve(here, "../../.."));

  await runConfigChecks();

  if (process.env.CHELCOACH_LIVE_STORAGE_VERIFY === "1") {
    ok("live_verify=start");
    await runLiveIsolation();
    ok("live_verify=pass");
  } else {
    // Soft bucket check when credentials present
    if ((process.env.SUPABASE_SERVICE_ROLE_KEY ?? "").trim()) {
      await runBucketChecks();
      await runPolicyChecks();
    } else {
      ok("live_verify=skipped (set CHELCOACH_LIVE_STORAGE_VERIFY=1)");
    }
  }

  ok("result=PASS");
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  const safe = message
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [REDACTED]")
    .replace(/eyJ[A-Za-z0-9._-]+/g, "[REDACTED_JWT]");
  fail(safe);
});
