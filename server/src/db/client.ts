/**
 * Lazy database client. The connection is created on first use so the server can
 * boot in Phase 0 without a DATABASE_URL (health + placeholder routes still work).
 */
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";

type Db = ReturnType<typeof drizzle<typeof schema>>;

let db: Db | null = null;

export function isDbConfigured(): boolean {
  return Boolean(process.env.DATABASE_URL);
}

export function getDb(): Db {
  if (db) return db;
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL is not set. Provision Postgres and set it (see docs/backend-setup-replit.md).",
    );
  }
  const pool = new Pool({ connectionString: url });
  db = drizzle(pool, { schema });
  return db;
}
