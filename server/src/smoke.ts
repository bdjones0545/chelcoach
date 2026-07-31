/**
 * Backend smoke test. No test framework — Node's built-in fetch + assert. Boots the app
 * on an ephemeral port and proves, with NO Postgres/ffmpeg/AI and the in-memory storage
 * backend:
 *   1. server boots + health (storage backend = memory)
 *   2. upload validation: unsupported type → 415, oversized → 413
 *   3. real upload loop: init → PUT bytes → commit → contract-valid report
 *   4. analysis-job status: schema-valid completed envelope + report availability
 *   5. failed status is representable
 *   6. malformed clip id → 400; unknown clip → 404
 *   7. back-compat: committing an un-init'd (demo) clip still completes
 *
 * Run: `npm run smoke`. Exits non-zero on any failure.
 */
process.env.STORAGE_BACKEND = "memory"; // deterministic: never touch Replit storage in tests

import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createApp } from "./app";
import { analysisJobStatusSchema, analysisReportSchema, uploadRules } from "./contract";
import { markFailed } from "./store";

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
  const jsonHeaders = { "content-type": "application/json" };

  try {
    // 1. health
    const health = await fetch(`${base}/api/health`);
    assert.equal(health.status, 200, "health status 200");
    const healthBody = (await health.json()) as { status: string; storageBackend: string };
    assert.equal(healthBody.status, "ok", 'health "ok"');
    assert.equal(healthBody.storageBackend, "memory", "storage backend is memory");
    pass("server boots + health (storage backend = memory)");

    // 2a. unsupported file type → 415
    const bad = await fetch(`${base}/api/uploads/init`, {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ filename: "clip.avi", contentType: "video/x-msvideo", sizeBytes: 1024 }),
    });
    assert.equal(bad.status, 415, "unsupported type → 415");
    assert.equal(((await bad.json()) as { error: string }).error, "unsupported_file", "error=unsupported_file");
    pass("upload init rejects unsupported file type (415)");

    // 2b. oversized → 413
    const big = await fetch(`${base}/api/uploads/init`, {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ filename: "clip.mp4", contentType: "video/mp4", sizeBytes: uploadRules.maxBytes + 1 }),
    });
    assert.equal(big.status, 413, "oversized → 413");
    assert.equal(((await big.json()) as { error: string }).error, "oversized_file", "error=oversized_file");
    pass("upload init rejects oversized file (413)");

    // 3. real upload loop: init → PUT bytes → commit → report
    const init = await fetch(`${base}/api/uploads/init`, {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ filename: "game.mp4", contentType: "video/mp4", sizeBytes: 12 }),
    });
    assert.equal(init.status, 201, "init → 201");
    const initBody = (await init.json()) as { clipId: string; uploadUrl: string };
    assert.ok(initBody.clipId, "init returns clipId");
    assert.equal(initBody.uploadUrl, `/api/clips/${initBody.clipId}/file`, "init returns uploadUrl");
    pass("upload init creates a clip + upload target (201)");

    const bytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    const put = await fetch(`${base}${initBody.uploadUrl}`, {
      method: "PUT",
      headers: { "content-type": "video/mp4" },
      body: bytes,
    });
    assert.equal(put.status, 200, "file PUT → 200");
    const putBody = (await put.json()) as { status: string; storedBytes: number };
    assert.equal(putBody.status, "queued", "clip queued after upload");
    assert.equal(putBody.storedBytes, 12, "stored byte count");
    pass("file bytes stored in object storage (queued)");

    // Status while queued (pre-commit) — schema-valid, report not ready.
    const queuedStatus = await fetch(`${base}/api/clips/${initBody.clipId}/status`);
    assert.equal(queuedStatus.status, 200, "queued status → 200");
    const queuedBody = analysisJobStatusSchema.parse(await queuedStatus.json());
    assert.equal(queuedBody.status, "queued", "public status queued");
    assert.equal(queuedBody.reportReady, false, "report not ready while queued");
    pass("GET status returns schema-valid queued envelope");

    const commit = await fetch(`${base}/api/clips/${initBody.clipId}/commit`, { method: "POST" });
    assert.equal(commit.status, 200, "commit → 200");
    assert.equal(((await commit.json()) as { status: string }).status, "complete", "commit → complete");
    pass("commit finalizes the uploaded clip (complete)");

    // 4. completed status + report availability
    const completedStatus = await fetch(`${base}/api/clips/${initBody.clipId}/status`);
    assert.equal(completedStatus.status, 200, "completed status → 200");
    const completedBody = analysisJobStatusSchema.parse(await completedStatus.json());
    assert.equal(completedBody.status, "completed", "public status completed");
    assert.equal(completedBody.reportReady, true, "reportReady true when complete");
    assert.equal(completedBody.clipId, initBody.clipId, "status clipId matches");
    pass("GET status returns schema-valid completed envelope");

    const get = await fetch(`${base}/api/clips/${initBody.clipId}`);
    const getBody = (await get.json()) as { status: string; report?: unknown };
    assert.equal(getBody.status, "complete", "get status complete");
    analysisReportSchema.parse(getBody.report);
    pass("GET clip returns a contract-valid complete report");

    const analysis = await fetch(`${base}/api/clips/${initBody.clipId}/analysis`);
    assert.equal(analysis.status, 200, "analysis → 200 when complete");
    analysisReportSchema.parse(((await analysis.json()) as { report: unknown }).report);
    pass("GET analysis returns report when status completed");

    // 5. failed status representable (in-process store; same Map the app uses)
    const failInit = await fetch(`${base}/api/uploads/init`, {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ filename: "fail.mp4", contentType: "video/mp4", sizeBytes: 4 }),
    });
    const failId = ((await failInit.json()) as { clipId: string }).clipId;
    await fetch(`${base}/api/clips/${failId}/file`, {
      method: "PUT",
      headers: { "content-type": "video/mp4" },
      body: new Uint8Array([1, 2, 3, 4]),
    });
    markFailed(failId, "analysis_failed", "Analysis failed.");
    const failedStatus = await fetch(`${base}/api/clips/${failId}/status`);
    assert.equal(failedStatus.status, 200, "failed status → 200");
    const failedBody = analysisJobStatusSchema.parse(await failedStatus.json());
    assert.equal(failedBody.status, "failed", "public status failed");
    assert.equal(failedBody.reportReady, false, "failed ⇒ report not ready");
    assert.equal(failedBody.errorCode, "analysis_failed", "safe error code");
    pass("GET status represents failed jobs");

    // 6. malformed id → 400; unknown id → 404
    const malformed = await fetch(`${base}/api/clips/bad.id!/status`);
    assert.equal(malformed.status, 400, "malformed id → 400");
    assert.equal(((await malformed.json()) as { error: string }).error, "invalid_clip_id", "error=invalid_clip_id");
    pass("GET status rejects malformed clip id (400)");

    const missing = await fetch(`${base}/api/clips/does-not-exist/status`);
    assert.equal(missing.status, 404, "unknown clip status → 404");
    pass("GET status unknown clip returns 404");

    const missingClip = await fetch(`${base}/api/clips/does-not-exist`);
    assert.equal(missingClip.status, 404, "unknown clip → 404");
    pass("GET unknown clip returns 404");

    // 7. back-compat: commit an un-init'd demo clip
    const demo = await fetch(`${base}/api/clips/static-demo-clip/commit`, { method: "POST" });
    assert.equal(demo.status, 200, "demo commit → 200");
    assert.equal(((await demo.json()) as { status: string }).status, "complete", "demo clip completes");
    const demoStatus = analysisJobStatusSchema.parse(
      await (await fetch(`${base}/api/clips/static-demo-clip/status`)).json(),
    );
    assert.equal(demoStatus.status, "completed", "demo status completed");
    assert.equal(demoStatus.reportReady, true, "demo report ready");
    pass("static/demo commit still works (back-compat)");

    console.log(`\nSMOKE PASSED — ${checks} checks`);
  } finally {
    server.close();
  }
}

main().catch((err) => {
  console.error("\nSMOKE FAILED:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
