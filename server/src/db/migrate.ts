/**
 * Apply committed Drizzle SQL migrations.
 * Prefer DATABASE_URL_MIGRATE / DATABASE_URL_DIRECT for Supabase direct connections.
 * Never logs the connection string.
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { loadLocalEnvFiles } from "../config/loadEnv";
import { databaseDiagnostics, loadDatabaseConfig } from "../config/databaseConfig";
import { createMigrationPool } from "./client";

const here = dirname(fileURLToPath(import.meta.url));

async function main(): Promise<void> {
  loadLocalEnvFiles(resolve(here, "../.."));
  loadLocalEnvFiles(resolve(here, "../../.."));

  const config = loadDatabaseConfig();
  if (!config.enabled) {
    console.error("[chelcoach-migrate] DATABASE_URL is not set.");
    process.exit(1);
  }
  const diag = databaseDiagnostics(config);
  console.log(
    `[chelcoach-migrate] provider=${diag.provider} mode=${diag.connectionMode} ssl=${diag.ssl} migrateUrlConfigured=${diag.migrateUrlConfigured}`,
  );

  const pool = createMigrationPool();
  try {
    const db = drizzle(pool);
    const migrationsFolder = resolve(here, "../../drizzle");
    await migrate(db, { migrationsFolder });
    console.log("[chelcoach-migrate] migrations applied (or already up to date)");
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  const safe = message
    .replace(/postgres(?:ql)?:\/\/[^\s]+/gi, "[REDACTED_DATABASE_URL]")
    .replace(/password=[^&\s]+/gi, "password=[REDACTED]");
  console.error(`[chelcoach-migrate] failed: ${safe}`);
  process.exit(1);
});
