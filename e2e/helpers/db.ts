import pg from "pg";

/**
 * The harness must read whatever the API just wrote.
 *
 * It previously always queried Postgres, while playwright.config.ts ran the API on in-memory
 * repositories with a blanked DATABASE_URL. Every count therefore came back zero from a database
 * the API had never touched, failing assertions on journeys that actually succeeded.
 *
 * playwright.config.ts now resolves one mode and publishes it here. In postgres mode we query the
 * same migration-built database the API writes to; in memory mode we ask the API's own E2E control
 * endpoint. We never silently fall back to querying an unrelated database.
 */
const PERSISTENCE = process.env.CHELCOACH_E2E_PERSISTENCE === "memory" ? "memory" : "postgres";
const DATABASE_URL =
  process.env.DATABASE_URL ||
  "postgresql://chelcoach:chelcoach@127.0.0.1:5432/chelcoach_test";
const API_URL = process.env.CHELCOACH_E2E_API_URL || "http://127.0.0.1:3011";
const E2E_SECRET = process.env.CHELCOACH_E2E_SECRET || "e2e-secret";

export function e2ePersistenceMode(): "memory" | "postgres" {
  return PERSISTENCE;
}

/** Process-local totals from the API itself, used only when it runs on memory repositories. */
async function memoryJobStats(): Promise<{ jobs: number; reports: number }> {
  const res = await fetch(`${API_URL}/api/internal/e2e/job-stats`, {
    headers: { "x-chelcoach-e2e-secret": E2E_SECRET },
  });
  if (!res.ok) {
    throw new Error(
      `[e2e-db] job-stats unavailable (${res.status}). The API and harness disagree about persistence.`,
    );
  }
  return (await res.json()) as { jobs: number; reports: number };
}

/**
 * Guard for assertions that only exist against a real database. Throwing beats returning 0, which
 * is precisely the silent failure this change removes.
 */
function requirePostgres(what: string): void {
  if (PERSISTENCE !== "postgres") {
    throw new Error(
      `[e2e-db] ${what} requires durable persistence. Set CHELCOACH_E2E_DATABASE_URL to a migrated database.`,
    );
  }
}

async function withClient<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/** Truncate durable tables between E2E tests (worker isolation via serial workers). */
export async function resetDurableState(): Promise<void> {
  if (PERSISTENCE === "memory") return;
  await withClient(async (client) => {
    try {
      await client.query(`
        TRUNCATE TABLE
          scotty_callback_events,
          scotty_analysis_job_events,
          scotty_analysis_reports,
          scotty_simulator_jobs,
          scotty_analysis_jobs,
          player_confirmations,
          player_candidates,
          confirmation_frames,
          player_identifications,
          processing_leases,
          media_cleanup_locks,
          media_uploads,
          gameplay_profiles,
          sessions
        RESTART IDENTITY CASCADE
      `);
    } catch (err) {
      console.warn("[e2e-db] truncate warning:", err instanceof Error ? err.message : err);
    }
  });
}

export async function countAnalysisJobs(): Promise<number> {
  if (PERSISTENCE === "memory") return (await memoryJobStats()).jobs;
  return withClient(async (client) => {
    const res = await client.query(`SELECT COUNT(*)::int AS c FROM scotty_analysis_jobs`);
    return res.rows[0]?.c ?? 0;
  });
}

export async function countSimulatorJobs(): Promise<number> {
  requirePostgres("countSimulatorJobs");
  return withClient(async (client) => {
    const res = await client.query(`SELECT COUNT(*)::int AS c FROM scotty_simulator_jobs`);
    return res.rows[0]?.c ?? 0;
  });
}

export async function countReports(): Promise<number> {
  if (PERSISTENCE === "memory") return (await memoryJobStats()).reports;
  return withClient(async (client) => {
    const res = await client.query(`SELECT COUNT(*)::int AS c FROM scotty_analysis_reports`);
    return res.rows[0]?.c ?? 0;
  });
}

export async function countActiveLeases(): Promise<number> {
  requirePostgres("countActiveLeases");
  return withClient(async (client) => {
    const res = await client.query(
      `SELECT COUNT(*)::int AS c FROM processing_leases WHERE status = 'active' AND released_at IS NULL`,
    );
    return res.rows[0]?.c ?? 0;
  });
}

export async function getJobByApplicationRequestId(applicationRequestId: string): Promise<{
  application_request_id: string;
  canonical_status: string;
  status_sequence_number: number;
  report_available: boolean;
  owner_id: string;
  upload_id: string;
} | null> {
  requirePostgres("getJobByApplicationRequestId");
  return withClient(async (client) => {
    const res = await client.query(
      `SELECT application_request_id, canonical_status, status_sequence_number, report_available, owner_id, upload_id
       FROM scotty_analysis_jobs WHERE application_request_id = $1`,
      [applicationRequestId],
    );
    return res.rows[0] ?? null;
  });
}

export async function getUploadRow(uploadId: string): Promise<{
  upload_status: string;
  storage_object_key: string | null;
  media_classification: string | null;
  owner_id: string;
} | null> {
  requirePostgres("getUploadRow");
  return withClient(async (client) => {
    const res = await client.query(
      `SELECT upload_status, storage_object_key, media_classification, owner_id
       FROM media_uploads WHERE id = $1`,
      [uploadId],
    );
    return res.rows[0] ?? null;
  });
}

export async function getEventSequences(applicationRequestId: string): Promise<number[]> {
  requirePostgres("getEventSequences");
  return withClient(async (client) => {
    const res = await client.query(
      `SELECT sequence_number FROM scotty_analysis_job_events
       WHERE application_request_id = $1 ORDER BY sequence_number ASC`,
      [applicationRequestId],
    );
    return res.rows.map((r) => Number(r.sequence_number));
  });
}

export async function assertNoSecretsInDb(applicationRequestId: string): Promise<void> {
  requirePostgres("assertNoSecretsInDb");
  await withClient(async (client) => {
    const job = await client.query(
      `SELECT row_to_json(t)::text AS j FROM scotty_analysis_jobs t WHERE application_request_id = $1`,
      [applicationRequestId],
    );
    const report = await client.query(
      `SELECT row_to_json(t)::text AS j FROM scotty_analysis_reports t WHERE application_request_id = $1`,
      [applicationRequestId],
    );
    const blob = `${job.rows[0]?.j ?? ""}${report.rows[0]?.j ?? ""}`;
    for (const leak of [
      "SCOTTY_SIGNING_SECRET",
      "postgresql://",
      "https://",
      "Bearer sk-",
    ]) {
      if (blob.includes(leak)) {
        throw new Error(`DB row leaked ${leak}`);
      }
    }
    // No raw video bytes in JSON columns.
    if (blob.includes("data:video") || blob.includes("AAAAIGZ0eXBpc29")) {
      throw new Error("DB appears to contain raw video payload");
    }
  });
}
