/**
 * Apply server/src/storage/sql/0001_storage_rls.sql against configured DATABASE_URL.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadLocalEnvFiles } from "../config/loadEnv";
import { createMigrationPool } from "../db/client";

const here = dirname(fileURLToPath(import.meta.url));

async function main(): Promise<void> {
  loadLocalEnvFiles(resolve(here, "../.."));
  loadLocalEnvFiles(resolve(here, "../../.."));
  const sql = readFileSync(resolve(here, "sql/0001_storage_rls.sql"), "utf8");
  const pool = createMigrationPool();
  try {
    await pool.query(sql);
    console.log("[apply:supabase-storage-rls] applied=true");
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[apply:supabase-storage-rls] FAIL: ${message.replace(/postgres(?:ql)?:\/\/[^\s]+/gi, "[REDACTED]")}`);
  process.exit(1);
});
