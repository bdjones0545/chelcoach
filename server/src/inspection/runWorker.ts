/**
 * Dedicated media-inspection worker process entrypoint.
 *
 * Placement: Scotty VM or dedicated media worker (NOT Vercel).
 * Usage: npm run worker:media-inspection
 *
 * Loops: claim → process → sleep. Bounded batch per tick.
 */
import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadLocalEnvFiles } from "../config/loadEnv";
import { wirePersistence } from "../persistence";
import { createMediaInspectionWorker } from "./worker";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

async function cleanStaleTemp(): Promise<void> {
  const root = process.env.CHELCOACH_INSPECTION_TMPDIR?.trim() || join(tmpdir(), "chelcoach-inspect");
  try {
    await fs.mkdir(root, { recursive: true });
    const entries = await fs.readdir(root);
    const cutoff = Date.now() - 2 * 3600_000;
    for (const name of entries) {
      if (!name.startsWith("job-") && !name.startsWith("chelcoach-inspect-")) continue;
      const full = join(root, name);
      try {
        const st = await fs.stat(full);
        if (st.mtimeMs < cutoff) await fs.rm(full, { force: true });
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }
}

async function main(): Promise<void> {
  loadLocalEnvFiles(resolve(here, "../.."));
  loadLocalEnvFiles(resolve(here, "../../.."));
  wirePersistence();
  await cleanStaleTemp();

  const workerId =
    process.env.CHELCOACH_INSPECTION_WORKER_ID?.trim() || `worker-${randomUUID().slice(0, 8)}`;
  const pollMs = Number(process.env.CHELCOACH_INSPECTION_POLL_MS ?? 2000);
  const batchLimit = Number(process.env.CHELCOACH_INSPECTION_BATCH_LIMIT ?? 2);
  const worker = createMediaInspectionWorker();

  console.log(
    `[chelcoach-inspection-worker] starting workerId=${workerId} pollMs=${pollMs} batch=${batchLimit}`,
  );

  let stopping = false;
  const stop = () => {
    stopping = true;
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  while (!stopping) {
    try {
      const batch = await worker.runBatch({
        workerId,
        limit: Math.min(Math.max(batchLimit, 1), 10),
      });
      if (batch.processed === 0) {
        await new Promise((r) => setTimeout(r, pollMs));
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "worker_tick_failed";
      console.error(`[chelcoach-inspection-worker] tick_error=${message.slice(0, 200)}`);
      await new Promise((r) => setTimeout(r, pollMs));
    }
  }
  console.log(`[chelcoach-inspection-worker] stopped workerId=${workerId}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
