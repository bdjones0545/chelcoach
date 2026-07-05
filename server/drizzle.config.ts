import type { Config } from "drizzle-kit";

/**
 * Drizzle Kit config for generating/pushing migrations.
 * Requires DATABASE_URL (see docs/backend-setup-replit.md). Not used at runtime.
 */
export default {
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "",
  },
} satisfies Config;
