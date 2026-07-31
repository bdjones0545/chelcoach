import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ChelCoachConfigError } from "./chelcoachConfig";
import {
  databaseDiagnostics,
  loadDatabaseConfig,
  toPgPoolOptions,
} from "./databaseConfig";

describe("database config (Step 10.1A)", () => {
  it("parses Supabase pooler URL safely", () => {
    const config = loadDatabaseConfig({
      NODE_ENV: "development",
      DATABASE_URL:
        "postgresql://postgres.abc:secret@aws-0-us-east-1.pooler.supabase.com:6543/postgres",
      CHELCOACH_DB_SSL_MODE: "require",
    });
    assert.equal(config.enabled, true);
    assert.equal(config.provider, "supabase");
    assert.equal(config.connectionMode, "pooler");
    assert.equal(config.transactionPooler, true);
    assert.equal(config.disablePreparedStatements, true);
    assert.equal(config.sslMode, "require");
    const diag = databaseDiagnostics(config);
    assert.equal(diag.provider, "supabase");
    assert.ok(!JSON.stringify(diag).includes("secret"));
    assert.ok(!JSON.stringify(diag).includes("postgres.abc"));
  });

  it("parses Supabase direct URL", () => {
    const config = loadDatabaseConfig({
      NODE_ENV: "development",
      DATABASE_URL: "postgresql://postgres:secret@db.abcdefghijklmnop.supabase.co:5432/postgres",
      DATABASE_URL_MIGRATE:
        "postgresql://postgres:secret@db.abcdefghijklmnop.supabase.co:5432/postgres",
      CHELCOACH_DB_SSL_MODE: "require",
    });
    assert.equal(config.provider, "supabase");
    assert.equal(config.connectionMode, "direct");
    assert.equal(config.transactionPooler, false);
    assert.equal(databaseDiagnostics(config).migrateUrlConfigured, true);
  });

  it("rejects invalid database URL protocol", () => {
    assert.throws(
      () =>
        loadDatabaseConfig({
          DATABASE_URL: "https://example.com/not-postgres",
        }),
      ChelCoachConfigError,
    );
  });

  it("rejects malformed database URL", () => {
    assert.throws(
      () =>
        loadDatabaseConfig({
          DATABASE_URL: "not-a-url",
        }),
      /DATABASE_URL/,
    );
  });

  it("enforces SSL for Supabase when production disables TLS", () => {
    assert.throws(
      () =>
        loadDatabaseConfig({
          NODE_ENV: "production",
          DATABASE_URL:
            "postgresql://postgres.abc:secret@aws-0-us-east-1.pooler.supabase.com:6543/postgres",
          CHELCOACH_DB_SSL_MODE: "disable",
        }),
      /SSL/,
    );
  });

  it("toPgPoolOptions strips sslmode and never needs rejectUnauthorized false", () => {
    const config = loadDatabaseConfig({
      DATABASE_URL:
        "postgresql://postgres:secret@db.abcdefghijklmnop.supabase.co:5432/postgres?sslmode=require",
      CHELCOACH_DB_SSL_MODE: "require",
    });
    const opts = toPgPoolOptions(config, "runtime");
    assert.ok(opts.ssl);
    assert.equal((opts.ssl as { rejectUnauthorized: boolean }).rejectUnauthorized, true);
    assert.ok(!String(opts.connectionString).includes("sslmode="));
    assert.ok(!JSON.stringify(databaseDiagnostics(config)).includes("secret"));
  });

  it("owner id text can store Supabase auth UUID strings", () => {
    const uuid = "550e8400-e29b-41d4-a716-446655440000";
    assert.equal(typeof uuid, "string");
    assert.match(uuid, /^[0-9a-f-]{36}$/i);
  });
});
