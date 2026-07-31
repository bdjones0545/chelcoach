/**
 * Lazy database client for ChelCoach.
 * Uses central database config (SSL, pool size, statement timeout).
 * Never logs the connection string.
 */
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import {
  databaseDiagnostics,
  loadDatabaseConfig,
  toPgPoolOptions,
  type DatabaseConfig,
} from "../config/databaseConfig";
import * as schema from "./schema";

type Db = ReturnType<typeof drizzle<typeof schema>>;

let db: Db | null = null;
let pool: Pool | null = null;
let activeConfig: DatabaseConfig | null = null;
let pingPromise: Promise<void> | null = null;

export function isDbConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return loadDatabaseConfig(env).enabled;
}

export function getDatabaseConfig(): DatabaseConfig {
  return activeConfig ?? loadDatabaseConfig();
}

export function getDb(): Db {
  if (db) return db;
  const config = loadDatabaseConfig();
  if (!config.enabled || !config.url) {
    throw new Error(
      "DATABASE_URL is not set. Provision Postgres/Supabase and set it (see docs/supabase-postgres-step10-1a.md).",
    );
  }
  if (config.transactionPooler && config.disablePreparedStatements) {
    // node-postgres + drizzle may still prepare statements; document for Vercel.
    // Session-mode pooler (port 5432 on *.pooler.supabase.com) is preferred until
    // a postgres.js adapter is introduced. We still allow the URL and surface diagnostics.
    console.warn(
      "[chelcoach-db] transaction pooler detected (port 6543). Prefer session-mode pooler or direct URL if you see prepared-statement errors.",
    );
  }
  const opts = toPgPoolOptions(config, "runtime");
  pool = new Pool(opts);
  pool.on("error", () => {
    console.error("[chelcoach-db] idle client error");
  });
  db = drizzle(pool, { schema });
  activeConfig = config;
  console.log(
    `[chelcoach-db] connected provider=${config.provider} mode=${config.connectionMode} ssl=${config.sslMode}`,
  );
  return db;
}

/** Open a one-shot pool for migrations (uses migrate URL when set). */
export function createMigrationPool(): Pool {
  const config = loadDatabaseConfig();
  const opts = toPgPoolOptions(config, "migrate");
  return new Pool(opts);
}

export async function pingDatabase(): Promise<void> {
  const client = getDb();
  await client.execute(sql`select 1 as ok`);
}

/** Ensure DB is reachable when configured — fail closed (no silent memory). */
export async function assertDatabaseReady(): Promise<void> {
  const config = loadDatabaseConfig();
  if (!config.enabled) return;
  if (!pingPromise) {
    pingPromise = (async () => {
      try {
        await pingDatabase();
      } catch (err) {
        resetDbClientForTests();
        const message = err instanceof Error ? err.message : "database unreachable";
        const safe = message
          .replace(/postgres(?:ql)?:\/\/[^\s]+/gi, "[REDACTED_DATABASE_URL]")
          .replace(/password=[^&\s]+/gi, "password=[REDACTED]");
        throw new Error(`DATABASE_UNAVAILABLE: ${safe}`);
      }
    })();
  }
  await pingPromise;
}

export function safeDatabaseDiagnostics(): Record<string, string | boolean | number> {
  const d = databaseDiagnostics(getDatabaseConfig());
  return {
    enabled: d.enabled,
    provider: d.provider,
    connectionMode: d.connectionMode,
    ssl: d.ssl,
    statementTimeoutMs: d.statementTimeoutMs,
    maxConnections: d.maxConnections,
    disablePreparedStatements: d.disablePreparedStatements,
    transactionPooler: d.transactionPooler,
    migrateUrlConfigured: d.migrateUrlConfigured,
  };
}

/** Test helper — reset singleton between suites. */
export function resetDbClientForTests(): void {
  const p = pool;
  db = null;
  pool = null;
  activeConfig = null;
  pingPromise = null;
  if (p) void p.end().catch(() => undefined);
}
