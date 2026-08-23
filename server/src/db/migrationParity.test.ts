/**
 * Migration parity logic (CI schema-provenance gate).
 *
 * CI built its database with `drizzle-kit push` while production applies the committed SQL in
 * server/drizzle. Both agreed by coincidence, not by enforcement — so a schema change shipped
 * without a matching migration would pass every test and fail on deploy.
 *
 * These tests pin the detection logic itself. The live half (real Postgres, real migration run,
 * idempotent second pass) is exercised by `npm run test:migration-parity` in CI, which is the only
 * place a real database is guaranteed.
 *
 * Scope note: parity here is TABLE level plus journal integrity. Column types, defaults, foreign
 * keys, unique constraints and indexes are NOT compared.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  compareTableSets,
  extractMigrationTables,
  extractSchemaTables,
  readMigrationSources,
  runStaticParity,
  verifyJournal,
} from "../../scripts/verify-migration-parity.mjs";

const serverRoot = resolve(import.meta.dirname, "../..");

describe("migration parity — extraction", () => {
  it("extracts pgTable names whether inline or on a following line", () => {
    const source = `
      export const sessions = pgTable("sessions", { id: text("id") });
      export const mediaUploads = pgTable(
        "media_uploads",
        { id: uuid("id") },
      );
    `;
    const tables = extractSchemaTables(source);
    assert.deepEqual([...tables].sort(), ["media_uploads", "sessions"]);
  });

  it("extracts CREATE TABLE names with and without IF NOT EXISTS and quoting", () => {
    const tables = extractMigrationTables([
      'CREATE TABLE "clips" (\n "id" uuid\n);',
      "CREATE TABLE IF NOT EXISTS analyses (id uuid);",
      'create table "media_uploads" (id uuid);',
    ]);
    assert.deepEqual([...tables].sort(), ["analyses", "clips", "media_uploads"]);
  });
});

describe("migration parity — drift detection", () => {
  it("flags a schema table that no migration creates", () => {
    // The exact defect this gate exists to catch: a model added without generating its SQL.
    const schemaTables = new Set(["clips", "__ci_missing_migration_probe__"]);
    const migrationTables = new Set(["clips"]);
    const result = compareTableSets(schemaTables, migrationTables);

    assert.equal(result.ok, false);
    assert.deepEqual(result.missingFromMigrations, ["__ci_missing_migration_probe__"]);
  });

  it("passes when every schema table has a migration", () => {
    const result = compareTableSets(new Set(["clips", "analyses"]), new Set(["clips", "analyses"]));
    assert.equal(result.ok, true);
    assert.deepEqual(result.missingFromMigrations, []);
  });

  it("reports migration tables absent from the schema without failing the gate", () => {
    // A table can legitimately outlive its model; surface it, do not block on it.
    const result = compareTableSets(new Set(["clips"]), new Set(["clips", "legacy_table"]));
    assert.equal(result.ok, true);
    assert.deepEqual(result.notInSchema, ["legacy_table"]);
  });
});

describe("migration parity — journal integrity", () => {
  it("accepts a contiguous journal matching its SQL files", () => {
    const journal = { entries: [{ idx: 0, tag: "0000_a" }, { idx: 1, tag: "0001_b" }] };
    const result = verifyJournal(journal, ["0000_a.sql", "0001_b.sql"]);
    assert.equal(result.ok, true);
  });

  it("flags a journal entry whose SQL file is missing", () => {
    const journal = { entries: [{ idx: 0, tag: "0000_a" }, { idx: 1, tag: "0001_missing" }] };
    const result = verifyJournal(journal, ["0000_a.sql"]);
    assert.equal(result.ok, false);
    assert.deepEqual(result.missingFiles, ["0001_missing"]);
  });

  it("flags a SQL file the journal does not track", () => {
    // An untracked file never runs, so production would silently miss it.
    const journal = { entries: [{ idx: 0, tag: "0000_a" }] };
    const result = verifyJournal(journal, ["0000_a.sql", "0001_untracked.sql"]);
    assert.equal(result.ok, false);
    assert.deepEqual(result.untrackedFiles, ["0001_untracked"]);
  });

  it("flags non-contiguous journal indices, which make ordering unreliable", () => {
    const journal = { entries: [{ idx: 0, tag: "0000_a" }, { idx: 2, tag: "0002_c" }] };
    const result = verifyJournal(journal, ["0000_a.sql", "0002_c.sql"]);
    assert.equal(result.ok, false);
    assert.equal(result.outOfOrder, true);
  });
});

describe("migration parity — this repository", () => {
  it("has table-level parity between schema.ts and committed migrations", () => {
    const result = runStaticParity();
    assert.equal(
      result.tableComparison.ok,
      true,
      `schema tables with no migration: ${result.tableComparison.missingFromMigrations.join(", ")}`,
    );
    assert.ok(result.schemaTables.size > 0, "schema table extraction must not be silently empty");
  });

  it("has a journal that matches its migration files", () => {
    const result = runStaticParity();
    assert.equal(result.journalComparison.ok, true);
    assert.equal(result.journalComparison.tags.length, result.migrationFiles.length);
  });

  it("keeps migrations create-only, which is what the table comparison assumes", () => {
    // If this ever fails, extractMigrationTables must learn about drops/renames before the gate
    // can be trusted again — otherwise it would report a false pass.
    const { sources } = readMigrationSources(resolve(serverRoot, "drizzle"));
    for (const sql of sources) {
      assert.equal(/DROP\s+TABLE/i.test(sql), false, "a DROP TABLE invalidates the create-set comparison");
      assert.equal(/RENAME\s+TO/i.test(sql), false, "a RENAME invalidates the create-set comparison");
    }
  });

  it("keeps production on the committed migration chain", () => {
    // The gate is only meaningful while production actually applies these files.
    const pkg = JSON.parse(readFileSync(resolve(serverRoot, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    assert.match(pkg.scripts["db:migrate"], /src\/db\/migrate\.ts/);
    const migrateSource = readFileSync(resolve(serverRoot, "src/db/migrate.ts"), "utf8");
    assert.match(migrateSource, /migrationsFolder/);
  });
});
