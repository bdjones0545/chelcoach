/**
 * Backend smoke test. No test framework — Node's built-in fetch + assert. Boots the app
 * on an ephemeral port and proves, with NO Postgres/ffmpeg/AI and the in-memory storage
 * backend:
 *   1. server boots + health (storage backend = memory)
 *   2. upload validation: unsupported type → 415, oversized → 413
 *   3. real upload loop: init → PUT bytes → commit → contract-valid report
 *   4. back-compat: committing an un-init'd (demo) clip still completes
 *   5. unknown clip → 404
 *
 * Run: `npm run smoke`. Exits non-zero on any failure.
 */
process.env.STORAGE_BACKEND = "memory"; // deterministic: never touch Replit storage in tests

import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createApp } from "./app";
import { analysisReportSchema, uploadRules } from "./contract";

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

    // 2c. valid extension but dangerous/non-video MIME → 415 (would have passed under old OR-logic)
    const htmlMime = await fetch(`${base}/api/uploads/init`, {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ filename: "evil.mp4", contentType: "text/html", sizeBytes: 1024 }),
    });
    assert.equal(htmlMime.status, 415, "valid ext + text/html MIME → 415");
    assert.equal(((await htmlMime.json()) as { error: string }).error, "unsupported_file", "error=unsupported_file");
    pass("upload init rejects dangerous MIME on a video extension (415)");

    // 2d. bad extension but valid video MIME → 415 (would have passed under old OR-logic)
    const badExt = await fetch(`${base}/api/uploads/init`, {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ filename: "evil.html", contentType: "video/mp4", sizeBytes: 1024 }),
    });
    assert.equal(badExt.status, 415, "bad ext + valid MIME → 415");
    assert.equal(((await badExt.json()) as { error: string }).error, "unsupported_file", "error=unsupported_file");
    pass("upload init rejects a non-video extension with a video MIME (415)");

    // 2e. generic application/octet-stream is not accepted by the server → 415
    const octet = await fetch(`${base}/api/uploads/init`, {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ filename: "clip.mp4", contentType: "application/octet-stream", sizeBytes: 1024 }),
    });
    assert.equal(octet.status, 415, "octet-stream → 415");
    assert.equal(((await octet.json()) as { error: string }).error, "unsupported_file", "error=unsupported_file");
    pass("upload init rejects application/octet-stream (415)");

    // 2f. positive control: MOV + video/quicktime still accepted → 201
    const mov = await fetch(`${base}/api/uploads/init`, {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ filename: "clip.mov", contentType: "video/quicktime", sizeBytes: 12 }),
    });
    assert.equal(mov.status, 201, "MOV + video/quicktime → 201");
    pass("upload init accepts a valid MOV clip (201)");

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

    const commit = await fetch(`${base}/api/clips/${initBody.clipId}/commit`, { method: "POST" });
    assert.equal(commit.status, 200, "commit → 200");
    assert.equal(((await commit.json()) as { status: string }).status, "complete", "commit → complete");
    pass("commit finalizes the uploaded clip (complete)");

    const get = await fetch(`${base}/api/clips/${initBody.clipId}`);
    const getBody = (await get.json()) as { status: string; report?: unknown };
    assert.equal(getBody.status, "complete", "get status complete");
    analysisReportSchema.parse(getBody.report); // the proof: contract-valid report
    pass("GET clip returns a contract-valid complete report");

    // 4. back-compat: commit an un-init'd demo clip
    const demo = await fetch(`${base}/api/clips/static-demo-clip/commit`, { method: "POST" });
    assert.equal(demo.status, 200, "demo commit → 200");
    assert.equal(((await demo.json()) as { status: string }).status, "complete", "demo clip completes");
    pass("static/demo commit still works (back-compat)");

    // 5. unknown clip → 404
    const missing = await fetch(`${base}/api/clips/does-not-exist`);
    assert.equal(missing.status, 404, "unknown clip → 404");
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
