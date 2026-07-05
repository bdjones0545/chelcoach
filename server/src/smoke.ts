/**
 * Backend smoke test (Phase 1 static loop). No test framework — Node's built-in
 * fetch + assert. Boots the app on an ephemeral port and proves the contract loop:
 *   1. server boots + health works
 *   2. commit returns a valid CommitResponse (status=complete)
 *   3. GET /clips/:id returns a contract-VALID complete report
 *   4. unknown clip → 404
 *
 * Run: `npm run smoke` (from server/). Exits non-zero on any failure.
 */
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createApp } from "./app";
import { analysisReportSchema } from "./contract";

async function main() {
  const app = createApp();
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;

  let checks = 0;
  const pass = (name: string) => {
    checks += 1;
    console.log(`  ✓ ${name}`);
  };

  try {
    // 1. health
    const health = await fetch(`${base}/api/health`);
    assert.equal(health.status, 200, "health status 200");
    const healthBody = (await health.json()) as { status: string };
    assert.equal(healthBody.status, "ok", 'health body status "ok"');
    pass("server boots + health returns ok");

    // 2. commit
    const clipId = "smoke-clip-1";
    const commit = await fetch(`${base}/api/clips/${clipId}/commit`, { method: "POST" });
    assert.equal(commit.status, 200, "commit status 200");
    const commitBody = (await commit.json()) as { clipId: string; jobId: string; status: string };
    assert.equal(commitBody.clipId, clipId, "commit echoes clipId");
    assert.equal(commitBody.status, "complete", "commit status complete");
    assert.ok(commitBody.jobId, "commit returns a jobId");
    pass("commit returns a valid CommitResponse (status=complete)");

    // 3. GET clip → contract-valid complete report
    const get = await fetch(`${base}/api/clips/${clipId}`);
    assert.equal(get.status, 200, "get status 200");
    const getBody = (await get.json()) as { clipId: string; status: string; phaseProgress: number; report?: unknown };
    assert.equal(getBody.clipId, clipId, "get echoes clipId");
    assert.equal(getBody.status, "complete", "get status complete");
    assert.equal(getBody.phaseProgress, 100, "get phaseProgress 100");
    assert.ok(getBody.report, "report present when complete");
    // The proof: the returned report validates against the shared contract.
    analysisReportSchema.parse(getBody.report);
    pass("GET /clips/:id returns a contract-valid complete report");

    // 4. unknown clip → 404
    const missing = await fetch(`${base}/api/clips/does-not-exist`);
    assert.equal(missing.status, 404, "unknown clip 404");
    pass("GET unknown clip returns 404");

    console.log(`\nSMOKE PASSED — ${checks} checks`);
  } finally {
    server.close();
  }
}

main().catch((err) => {
  console.error("\nSMOKE FAILED:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
