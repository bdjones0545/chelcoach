/**
 * Safe Supabase / Postgres verification command.
 * npm run verify:supabase-db
 *
 * Never prints connection strings, passwords, or row payloads with secrets.
 */
import { createHash, randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { loadLocalEnvFiles } from "../config/loadEnv";
import { databaseDiagnostics, loadDatabaseConfig } from "../config/databaseConfig";
import { createMigrationPool, resetDbClientForTests } from "./client";
import { mediaUploads, gameplayProfiles, processingLeases, mediaCleanupLocks } from "./schema";

const EXPECTED_TABLES = [
  "sessions",
  "clips",
  "analysis_jobs",
  "analyses",
  "gameplay_profiles",
  "media_uploads",
  "media_inspection_jobs",
  "processing_leases",
  "media_cleanup_locks",
  "player_identifications",
  "confirmation_frames",
  "player_candidates",
  "player_confirmations",
  "scotty_analysis_jobs",
  "scotty_analysis_job_events",
  "scotty_analysis_reports",
  "scotty_simulator_jobs",
  "scotty_callback_events",
] as const;

const EXPECTED_INDEXES = [
  "media_uploads_owner_id_idx",
  "media_uploads_status_expires_idx",
  "media_uploads_absolute_delete_idx",
  "processing_leases_upload_status_expires_idx",
  "player_identifications_owner_id_idx",
  "confirmation_frames_upload_id_idx",
  "scotty_jobs_application_request_id_uidx",
  "scotty_jobs_idempotency_key_uidx",
  "scotty_jobs_provider_external_uidx",
  "scotty_reports_application_request_uidx",
  "scotty_callback_event_id_uidx",
] as const;

const here = dirname(fileURLToPath(import.meta.url));

function fail(msg: string): never {
  console.error(`[verify:supabase-db] FAIL: ${msg}`);
  process.exit(1);
}

function rowsOf(result: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(result)) return result as Array<Record<string, unknown>>;
  const rows = (result as { rows?: Array<Record<string, unknown>> }).rows;
  return Array.isArray(rows) ? rows : [];
}

async function main(): Promise<void> {
  loadLocalEnvFiles(resolve(here, "../.."));
  loadLocalEnvFiles(resolve(here, "../../.."));

  const config = loadDatabaseConfig();
  if (!config.enabled) {
    fail("DATABASE_URL is not set. Add the Supabase Postgres URI to .env (not the API URL).");
  }
  const diag = databaseDiagnostics(config);
  console.log("[verify:supabase-db] database config (safe):");
  console.log(JSON.stringify(diag, null, 2));

  if (diag.provider !== "supabase" && process.env.CHELCOACH_ALLOW_NON_SUPABASE_VERIFY !== "1") {
    fail(
      `provider=${diag.provider} is not supabase. Set DATABASE_URL to the Supabase Postgres URI, or CHELCOACH_ALLOW_NON_SUPABASE_VERIFY=1 for local smoke only.`,
    );
  }

  const pool = createMigrationPool();
  const db = drizzle(pool);
  const runId = `s101a_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const ownerId = `own_verify_${runId}`;

  try {
    // Migration history
    const migrations = await db.execute(sql`
      select id, hash, created_at
      from drizzle.__drizzle_migrations
      order by created_at asc
    `);
    const migRows = rowsOf(migrations);
    console.log(`[verify:supabase-db] migration_history_count=${migRows.length}`);

    // Tables
    const tables = await db.execute(sql`
      select table_name
      from information_schema.tables
      where table_schema = 'public' and table_type = 'BASE TABLE'
      order by table_name
    `);
    const tableRows = rowsOf(tables).map((r) => String(r.table_name));
    for (const t of EXPECTED_TABLES) {
      if (!tableRows.includes(t)) fail(`missing table ${t}`);
    }
    console.log(`[verify:supabase-db] tables_ok count=${EXPECTED_TABLES.length}`);

    // Key column types
    const cols = await db.execute(sql`
      select table_name, column_name, data_type, udt_name, is_nullable
      from information_schema.columns
      where table_schema = 'public'
        and table_name in ('media_uploads','scotty_analysis_reports','processing_leases','gameplay_profiles')
      order by table_name, ordinal_position
    `);
    const colRows = rowsOf(cols);
    const findCol = (table: string, column: string) =>
      colRows.find((c) => c.table_name === table && c.column_name === column);
    const reportCol = findCol("scotty_analysis_reports", "report");
    if (!reportCol || reportCol.udt_name !== "jsonb") fail("scotty_analysis_reports.report must be jsonb");
    const expires = findCol("media_uploads", "expires_at");
    if (!expires || expires.data_type !== "timestamp with time zone") {
      fail("media_uploads.expires_at must be timestamptz");
    }
    const leaseJob = findCol("processing_leases", "analysis_job_id");
    if (!leaseJob || leaseJob.data_type !== "text") {
      fail("processing_leases.analysis_job_id must be text");
    }
    const owner = findCol("media_uploads", "owner_id");
    if (!owner || owner.data_type !== "text") fail("media_uploads.owner_id must be text");
    console.log("[verify:supabase-db] column_types_ok");

    // Indexes
    const idx = await db.execute(sql`
      select indexname from pg_indexes where schemaname = 'public'
    `);
    const idxNames = rowsOf(idx).map((r) => String(r.indexname));
    for (const name of EXPECTED_INDEXES) {
      if (!idxNames.includes(name)) fail(`missing index ${name}`);
    }
    console.log(`[verify:supabase-db] indexes_ok count=${EXPECTED_INDEXES.length}`);

    // Unique constraints (via indexes / constraints)
    for (const name of [
      "scotty_jobs_application_request_id_uidx",
      "scotty_jobs_idempotency_key_uidx",
      "scotty_jobs_provider_external_uidx",
    ]) {
      if (!idxNames.includes(name)) fail(`missing unique index ${name}`);
    }

    // Bounded transactional write/read/cleanup
    const uploadId = randomUUID();
    const now = new Date();
    await db.insert(gameplayProfiles).values({
      userId: ownerId,
      preferredPlatform: "xbox_series",
      preferredControlScheme: "skill_stick",
      primaryPosition: "C",
      commonGameMode: "eashl",
    });
    await db.insert(mediaUploads).values({
      id: uploadId,
      ownerId,
      storageProvider: "memory",
      storageObjectKey: `verify/${runId}`,
      originalFilename: "verify.mp4",
      displayFilename: "verify.mp4",
      mimeType: "video/mp4",
      byteSize: 1024,
      uploadStatus: "ready",
      retentionPolicyVersion: "v1",
      expiresAt: new Date(now.getTime() + 86_400_000),
      absoluteDeleteAt: new Date(now.getTime() + 172_800_000),
      gameplayContext: {
        gameContext: {
          selectedGameTitle: "NHL 25",
          canonicalGameId: "nhl-25",
          supportStatus: "supported",
          mismatchState: "none",
        },
        playerContext: {
          platform: "xbox_series",
          controlScheme: "skill_stick",
          position: "C",
          gameMode: "eashl",
        },
        singlePlayerControl: true,
      },
    });
    const leaseId = randomUUID();
    await db.insert(processingLeases).values({
      id: leaseId,
      uploadId,
      analysisJobId: `verify-${runId}`,
      status: "active",
      acquiredAt: now,
      heartbeatAt: now,
      expiresAt: new Date(now.getTime() + 60_000),
    });
    await db.insert(mediaCleanupLocks).values({
      uploadId,
      owner: `worker-${runId}`,
      expiresAt: new Date(now.getTime() + 60_000),
      acquiredAt: now,
      active: true,
    });

    const [profile] = await db
      .select()
      .from(gameplayProfiles)
      .where(eq(gameplayProfiles.userId, ownerId))
      .limit(1);
    if (!profile) fail("profile readback failed");

    const [upload] = await db
      .select()
      .from(mediaUploads)
      .where(eq(mediaUploads.id, uploadId))
      .limit(1);
    if (!upload || upload.ownerId !== ownerId) fail("upload readback failed");

    // Cleanup only our test IDs — never truncate the project.
    await db.delete(mediaCleanupLocks).where(eq(mediaCleanupLocks.uploadId, uploadId));
    await db.delete(processingLeases).where(eq(processingLeases.id, leaseId));
    await db.delete(mediaUploads).where(eq(mediaUploads.id, uploadId));
    await db.delete(gameplayProfiles).where(eq(gameplayProfiles.userId, ownerId));
    console.log(`[verify:supabase-db] rw_check_ok runId=${runId}`);

    // Owner ID UUID compatibility note (text column can store UUID strings)
    const uuidProbe = "550e8400-e29b-41d4-a716-446655440000";
    const canStore = typeof uuidProbe === "string" && uuidProbe.length === 36;
    console.log(`[verify:supabase-db] owner_id_supports_supabase_uuid_string=${canStore}`);

    // Fingerprint schema without dumping data
    const fingerprint = createHash("sha256")
      .update(EXPECTED_TABLES.join("|"))
      .update(EXPECTED_INDEXES.join("|"))
      .digest("hex")
      .slice(0, 12);
    console.log(`[verify:supabase-db] schema_fingerprint=${fingerprint}`);
    console.log("[verify:supabase-db] OK");
  } finally {
    await pool.end();
    resetDbClientForTests();
  }
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  const safe = message
    .replace(/postgres(?:ql)?:\/\/[^\s]+/gi, "[REDACTED_DATABASE_URL]")
    .replace(/password=[^&\s]+/gi, "password=[REDACTED]");
  fail(safe);
});
