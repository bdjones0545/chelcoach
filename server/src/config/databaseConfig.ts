/**
 * Central database configuration for ChelCoach → Postgres / Supabase.
 * Never log the full connection URL or password.
 */
import { ChelCoachConfigError } from "./chelcoachConfig";

export type DbSslMode = "require" | "verify-full" | "disable";
export type DbConnectionMode = "direct" | "pooler" | "local";

export type DatabaseConfig = {
  enabled: boolean;
  /** Runtime URL — never log. */
  url: string | null;
  /** Optional direct URL for migrations; falls back to url. */
  migrateUrl: string | null;
  sslMode: DbSslMode;
  connectionMode: DbConnectionMode;
  /** Inferred provider label for safe diagnostics. */
  provider: "supabase" | "local" | "other" | "none";
  statementTimeoutMs: number;
  maxConnections: number;
  /** Disable prepared statements for transaction-mode poolers. */
  disablePreparedStatements: boolean;
  /** True when URL looks like Supabase transaction pooler (port 6543). */
  transactionPooler: boolean;
};

export type DatabaseDiagnostics = {
  enabled: boolean;
  provider: DatabaseConfig["provider"];
  connectionMode: DbConnectionMode;
  ssl: DbSslMode;
  statementTimeoutMs: number;
  maxConnections: number;
  disablePreparedStatements: boolean;
  transactionPooler: boolean;
  migrateUrlConfigured: boolean;
};

function parseSslMode(raw: string | undefined, isProduction: boolean): DbSslMode {
  const v = (raw ?? "").trim().toLowerCase();
  if (!v) return isProduction ? "require" : "disable";
  if (v === "require" || v === "verify-full" || v === "disable") return v;
  throw new ChelCoachConfigError(
    "INVALID_DB_SSL_MODE",
    `Unsupported CHELCOACH_DB_SSL_MODE="${raw}". Use require | verify-full | disable.`,
  );
}

function intEnv(raw: string | undefined, fallback: number, min: number, max: number, name: string): number {
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min || n > max) {
    throw new ChelCoachConfigError(
      "INVALID_DB_INT",
      `Invalid ${name}=${raw} (expected ${min}–${max}).`,
    );
  }
  return Math.floor(n);
}

function classifyUrl(url: string): {
  connectionMode: DbConnectionMode;
  provider: DatabaseConfig["provider"];
  transactionPooler: boolean;
} {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ChelCoachConfigError(
      "INVALID_DATABASE_URL",
      "DATABASE_URL is not a valid URL.",
    );
  }
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new ChelCoachConfigError(
      "INVALID_DATABASE_URL",
      "DATABASE_URL must use postgres:// or postgresql://.",
    );
  }
  const host = (parsed.hostname || "").toLowerCase();
  const port = parsed.port ? Number(parsed.port) : 5432;
  const isSupabase =
    host.endsWith(".supabase.co") ||
    host.endsWith(".supabase.com") ||
    host.includes("pooler.supabase.com");
  const transactionPooler = isSupabase && port === 6543;
  const connectionMode: DbConnectionMode =
    host === "localhost" || host === "127.0.0.1"
      ? "local"
      : transactionPooler || host.includes("pooler.supabase.com")
        ? "pooler"
        : isSupabase
          ? "direct"
          : "direct";
  return {
    connectionMode,
    provider: isSupabase ? "supabase" : connectionMode === "local" ? "local" : "other",
    transactionPooler,
  };
}

/** Load database config from env. Does not open a connection. */
export function loadDatabaseConfig(
  env: NodeJS.ProcessEnv = process.env,
): DatabaseConfig {
  const isProduction = (env.NODE_ENV ?? "development") === "production";
  const url = (env.DATABASE_URL ?? "").trim() || null;
  const migrateUrl =
    (env.DATABASE_URL_MIGRATE ?? env.DATABASE_URL_DIRECT ?? "").trim() || url;
  const sslMode = parseSslMode(env.CHELCOACH_DB_SSL_MODE, isProduction);
  const statementTimeoutMs = intEnv(
    env.CHELCOACH_DB_STATEMENT_TIMEOUT_MS,
    15_000,
    1_000,
    600_000,
    "CHELCOACH_DB_STATEMENT_TIMEOUT_MS",
  );
  const maxConnections = intEnv(
    env.CHELCOACH_DB_MAX_CONNECTIONS,
    isProduction ? 5 : 10,
    1,
    50,
    "CHELCOACH_DB_MAX_CONNECTIONS",
  );

  if (!url) {
    return {
      enabled: false,
      url: null,
      migrateUrl: null,
      sslMode,
      connectionMode: "local",
      provider: "none",
      statementTimeoutMs,
      maxConnections,
      disablePreparedStatements: false,
      transactionPooler: false,
    };
  }

  const classified = classifyUrl(url);
  const modeOverride = (env.CHELCOACH_DB_CONNECTION_MODE ?? "").trim().toLowerCase();
  let connectionMode = classified.connectionMode;
  if (modeOverride === "direct" || modeOverride === "pooler" || modeOverride === "local") {
    connectionMode = modeOverride;
  } else if (modeOverride && modeOverride !== "auto") {
    throw new ChelCoachConfigError(
      "INVALID_DB_CONNECTION_MODE",
      `Unsupported CHELCOACH_DB_CONNECTION_MODE="${modeOverride}". Use auto | direct | pooler | local.`,
    );
  }

  if (isProduction && sslMode === "disable" && classified.provider === "supabase") {
    throw new ChelCoachConfigError(
      "DB_SSL_REQUIRED",
      "Supabase production connections require CHELCOACH_DB_SSL_MODE=require or verify-full.",
    );
  }

  // Transaction pooler (6543) cannot use prepared statements.
  const disablePreparedStatements =
    classified.transactionPooler ||
    env.CHELCOACH_DB_DISABLE_PREPARED_STATEMENTS === "1";

  // Local Postgres typically has no TLS. Supabase always needs TLS.
  let effectiveSsl = sslMode;
  if (classified.provider === "supabase" && effectiveSsl === "disable") {
    effectiveSsl = "require";
  } else if (classified.provider === "local" && env.CHELCOACH_DB_FORCE_SSL_LOCAL !== "1") {
    effectiveSsl = "disable";
  }

  return {
    enabled: true,
    url,
    migrateUrl,
    sslMode: effectiveSsl,
    connectionMode,
    provider: classified.provider,
    statementTimeoutMs,
    maxConnections,
    disablePreparedStatements,
    transactionPooler: classified.transactionPooler,
  };
}

export function databaseDiagnostics(config: DatabaseConfig): DatabaseDiagnostics {
  return {
    enabled: config.enabled,
    provider: config.provider,
    connectionMode: config.connectionMode,
    ssl: config.sslMode,
    statementTimeoutMs: config.statementTimeoutMs,
    maxConnections: config.maxConnections,
    disablePreparedStatements: config.disablePreparedStatements,
    transactionPooler: config.transactionPooler,
    migrateUrlConfigured: Boolean(config.migrateUrl),
  };
}

/** Build pg Pool config without embedding secrets in returned logs. */
export function toPgPoolOptions(config: DatabaseConfig, purpose: "runtime" | "migrate") {
  const connectionString = purpose === "migrate" ? config.migrateUrl : config.url;
  if (!connectionString) {
    throw new ChelCoachConfigError("DATABASE_URL_MISSING", "DATABASE_URL is not configured.");
  }
  // Prefer ssl object over sslmode query param for node-postgres predictability.
  let cleaned = connectionString;
  try {
    const u = new URL(connectionString);
    u.searchParams.delete("sslmode");
    cleaned = u.toString();
  } catch {
    cleaned = connectionString;
  }

  const ssl =
    config.sslMode === "disable"
      ? undefined
      : {
          // verify-full / require: keep certificate verification enabled (system CAs).
          // Do not set rejectUnauthorized: false.
          rejectUnauthorized: true,
        };

  return {
    connectionString: cleaned,
    max: purpose === "migrate" ? 1 : config.maxConnections,
    ssl,
    // node-pg: statement_timeout via startup options
    options: `-c statement_timeout=${config.statementTimeoutMs}`,
  };
}
