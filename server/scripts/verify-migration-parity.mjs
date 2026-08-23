#!/usr/bin/env node
/**
 * Migration parity gate.
 *
 * The risk this closes: CI used to build its database with `drizzle-kit push`, which diffs
 * schema.ts straight into Postgres, while production applies the committed SQL in server/drizzle.
 * Every integration test therefore validated a schema production never builds, and a schema change
 * shipped without a matching migration would pass CI and fail on deploy.
 *
 * SCOPE — read this before trusting the gate:
 * This verifies parity at TABLE level and migration-journal integrity. It does NOT verify column
 * types, defaults, nullability, foreign keys, unique constraints, or indexes. A migration that
 * creates the right tables with the wrong columns still passes. Table-level parity plus real
 * migration execution is what is proven here; claiming more would be worse than claiming less.
 *
 * Static checks (always):
 *   1. every pgTable() in schema.ts is created by some committed migration
 *   2. every journal entry has a SQL file, and every SQL file has a journal entry
 *
 * Live checks (only when DATABASE_URL is set):
 *   3. the production entrypoint (src/db/migrate.ts) applies cleanly to the target database
 *   4. the resulting public tables match the intended schema table set
 *   5. running the migrations a second time succeeds — proving already-applied handling
 *
 * Assumption: the committed migrations are create-only. If a future migration drops or renames a
 * table, extractMigrationTables must learn about it or this gate will report a false pass.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const serverRoot = resolve(here, "..");
const schemaPath = join(serverRoot, "src/db/schema.ts");
const migrationsDir = join(serverRoot, "drizzle");
const journalPath = join(migrationsDir, "meta/_journal.json");

/** Table names declared via pgTable("name", …). The name may sit on a following line. */
export function extractSchemaTables(source) {
  const names = [...source.matchAll(/pgTable\(\s*["']([A-Za-z0-9_]+)["']/g)].map((m) => m[1]);
  return new Set(names);
}

/** Table names created by committed migration SQL. */
export function extractMigrationTables(sqlSources) {
  const created = new Set();
  for (const sql of sqlSources) {
    for (const m of sql.matchAll(
      /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["']?([A-Za-z0-9_]+)["']?/gi,
    )) {
      created.add(m[1]);
    }
  }
  return created;
}

/**
 * Tables the application expects that no migration creates. This is the dangerous direction:
 * production would be missing them entirely.
 */
export function compareTableSets(schemaTables, migrationTables) {
  const missingFromMigrations = [...schemaTables].filter((t) => !migrationTables.has(t)).sort();
  const notInSchema = [...migrationTables].filter((t) => !schemaTables.has(t)).sort();
  return { missingFromMigrations, notInSchema, ok: missingFromMigrations.length === 0 };
}

/** Journal entries and SQL files must correspond one-to-one, or migration order is unreliable. */
export function verifyJournal(journal, sqlFileNames) {
  const tags = (journal.entries ?? []).map((e) => e.tag);
  const files = sqlFileNames.map((f) => f.replace(/\.sql$/, ""));
  const missingFiles = tags.filter((t) => !files.includes(t)).sort();
  const untrackedFiles = files.filter((f) => !tags.includes(f)).sort();
  const indices = (journal.entries ?? []).map((e) => e.idx);
  const outOfOrder = indices.some((idx, i) => idx !== i);
  return {
    tags,
    missingFiles,
    untrackedFiles,
    outOfOrder,
    ok: missingFiles.length === 0 && untrackedFiles.length === 0 && !outOfOrder,
  };
}

export function readMigrationSources(dir = migrationsDir) {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  return { files, sources: files.map((f) => readFileSync(join(dir, f), "utf8")) };
}

export function runStaticParity() {
  const schemaTables = extractSchemaTables(readFileSync(schemaPath, "utf8"));
  const { files, sources } = readMigrationSources();
  const migrationTables = extractMigrationTables(sources);
  const journal = JSON.parse(readFileSync(journalPath, "utf8"));
  return {
    schemaTables,
    migrationTables,
    tableComparison: compareTableSets(schemaTables, migrationTables),
    journalComparison: verifyJournal(journal, files),
    migrationFiles: files,
  };
}

function applyMigrations(label) {
  // Deliberately invokes the production entrypoint rather than reimplementing it, so this gate
  // fails if that path breaks.
  execFileSync("npx", ["tsx", "src/db/migrate.ts"], {
    cwd: serverRoot,
    stdio: "inherit",
    env: process.env,
  });
  console.log(`[parity] migrations applied (${label})`);
}

async function listPublicTables(databaseUrl) {
  const { default: pg } = await import("pg");
  const client = new pg.Client({
    connectionString: databaseUrl,
    ssl: /localhost|127\.0\.0\.1/.test(databaseUrl) ? false : { rejectUnauthorized: false },
  });
  await client.connect();
  try {
    const { rows } = await client.query(
      "select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE'",
    );
    return new Set(rows.map((r) => r.table_name));
  } finally {
    await client.end();
  }
}

async function main() {
  let failed = false;
  const staticResult = runStaticParity();

  console.log(`[parity] schema tables:        ${staticResult.schemaTables.size}`);
  console.log(`[parity] migration files:      ${staticResult.migrationFiles.length}`);
  console.log(`[parity] migration-created:    ${staticResult.migrationTables.size}`);

  if (!staticResult.tableComparison.ok) {
    console.error(
      `[parity] FAIL — schema tables with no committed migration: ${staticResult.tableComparison.missingFromMigrations.join(", ")}`,
    );
    console.error("[parity] run `npm run db:generate` and commit the generated SQL.");
    failed = true;
  } else {
    console.log("[parity] OK — every schema table is created by a committed migration");
  }

  if (staticResult.tableComparison.notInSchema.length > 0) {
    // Not fatal on its own: a table can legitimately outlive its model. Surface it for review.
    console.warn(
      `[parity] NOTE — migration tables absent from schema.ts: ${staticResult.tableComparison.notInSchema.join(", ")}`,
    );
  }

  if (!staticResult.journalComparison.ok) {
    const j = staticResult.journalComparison;
    if (j.missingFiles.length) console.error(`[parity] FAIL — journal tags with no SQL file: ${j.missingFiles.join(", ")}`);
    if (j.untrackedFiles.length) console.error(`[parity] FAIL — SQL files absent from journal: ${j.untrackedFiles.join(", ")}`);
    if (j.outOfOrder) console.error("[parity] FAIL — journal indices are not contiguous and ordered");
    failed = true;
  } else {
    console.log(`[parity] OK — journal and SQL files correspond (${staticResult.journalComparison.tags.length} entries)`);
  }

  const databaseUrl = (process.env.DATABASE_URL ?? "").trim();
  if (!databaseUrl) {
    console.log("[parity] DATABASE_URL not set — static checks only, live migration not executed");
    process.exit(failed ? 1 : 0);
  }

  applyMigrations("first pass");
  const live = await listPublicTables(databaseUrl);
  console.log(`[parity] live public tables:   ${live.size}`);

  const missingLive = [...staticResult.schemaTables].filter((t) => !live.has(t)).sort();
  if (missingLive.length > 0) {
    console.error(`[parity] FAIL — schema tables absent from the migrated database: ${missingLive.join(", ")}`);
    failed = true;
  } else {
    console.log("[parity] OK — migrated database contains every intended schema table");
  }

  // Second pass proves already-applied migrations are handled, which is what a redeploy does.
  applyMigrations("second pass (idempotency)");
  const liveAgain = await listPublicTables(databaseUrl);
  if (liveAgain.size !== live.size) {
    console.error(`[parity] FAIL — table count changed on re-run: ${live.size} -> ${liveAgain.size}`);
    failed = true;
  } else {
    console.log(`[parity] OK — re-running migrations is safe (${liveAgain.size} tables, unchanged)`);
  }

  console.log(failed ? "[parity] RESULT: FAIL" : "[parity] RESULT: PASS");
  process.exit(failed ? 1 : 0);
}

// Only run the CLI when executed directly, so the unit test can import the pure helpers.
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      `[parity] failed: ${message.replace(/postgres(?:ql)?:\/\/[^\s]+/gi, "[REDACTED_DATABASE_URL]")}`,
    );
    process.exit(1);
  });
}
