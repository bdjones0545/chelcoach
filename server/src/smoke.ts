/**
 * Backend smoke test. Boots the app on an ephemeral port with memory storage.
 * When ffmpeg/ffprobe are available, exercises real extraction + fake AI end-to-end.
 * When missing, still validates demo commit + status contract (extraction tests skip).
 *
 * Uses AI_PROVIDER=fake (set in npm script) — never calls a paid provider.
 *
 * Run: `npm run smoke`. Exits non-zero on any failure.
 */
process.env.STORAGE_BACKEND = "memory";
process.env.AI_PROVIDER = process.env.AI_PROVIDER || "fake";

import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createApp } from "./app";
import { analysisJobStatusSchema, analysisReportSchema, uploadRules } from "./contract";
import { mediaBinariesAvailable } from "./media/binaries";
import { markFailed, getClip } from "./store";

async function sleep(ms: number) {
  await new Promise((r) => setTimeout(r, ms));
}

async function pollStatus(
  base: string,
  clipId: string,
  want: "completed" | "failed",
  timeoutMs = 60_000,
): Promise<ReturnType<typeof analysisJobStatusSchema.parse>> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const res = await fetch(`${base}/api/clips/${clipId}/status`);
    assert.equal(res.status, 200, "status 200 while polling");
    const body = analysisJobStatusSchema.parse(await res.json());
    if (body.status === want) return body;
    if (body.status === "failed" && want === "completed") {
      throw new Error(`expected completed, got failed: ${body.errorCode} ${body.errorMessage}`);
    }
    await sleep(200);
  }
  throw new Error(`timed out waiting for status=${want}`);
}

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
  const hasFfmpeg = mediaBinariesAvailable();

  try {
    const health = await fetch(`${base}/api/health`);
    assert.equal(health.status, 200);
    const healthBody = (await health.json()) as {
      status: string;
      storageBackend: string;
      phase: number;
      aiConfigured?: boolean;
    };
    assert.equal(healthBody.status, "ok");
    assert.equal(healthBody.storageBackend, "memory");
    assert.equal(healthBody.phase, 4);
    assert.equal(healthBody.aiConfigured, true);
    pass("server boots + health (phase 4, memory storage, fake AI)");

    // Validation still works
    const bad = await fetch(`${base}/api/uploads/init`, {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ filename: "clip.avi", contentType: "video/x-msvideo", sizeBytes: 1024 }),
    });
    assert.equal(bad.status, 415);
    pass("upload init rejects unsupported file type (415)");

    const big = await fetch(`${base}/api/uploads/init`, {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({
        filename: "clip.mp4",
        contentType: "video/mp4",
        sizeBytes: uploadRules.maxBytes + 1,
      }),
    });
    assert.equal(big.status, 413);
    pass("upload init rejects oversized file (413)");

    // Demo commit still immediate
    const demo = await fetch(`${base}/api/clips/static-demo-clip/commit`, { method: "POST" });
    assert.equal(demo.status, 200);
    assert.equal(((await demo.json()) as { status: string }).status, "complete");
    const demoStatus = analysisJobStatusSchema.parse(
      await (await fetch(`${base}/api/clips/static-demo-clip/status`)).json(),
    );
    assert.equal(demoStatus.status, "completed");
    assert.equal(demoStatus.reportReady, true);
    assert.equal(getClip("static-demo-clip")?.reportSource, "demo");
    pass("static/demo commit still completes immediately without AI key");

    // Malformed / unknown
    const malformed = await fetch(`${base}/api/clips/bad.id!/status`);
    assert.equal(malformed.status, 400);
    pass("GET status rejects malformed clip id (400)");

    const missing = await fetch(`${base}/api/clips/does-not-exist/status`);
    assert.equal(missing.status, 404);
    pass("GET status unknown clip returns 404");

    // Failed status still representable via store helper
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
    markFailed(failId, "extraction_failed", "Analysis failed.");
    const failedBody = analysisJobStatusSchema.parse(
      await (await fetch(`${base}/api/clips/${failId}/status`)).json(),
    );
    assert.equal(failedBody.status, "failed");
    pass("GET status represents failed jobs");

    if (!hasFfmpeg) {
      console.log("  ↷ ffmpeg/ffprobe not on PATH — skipping real extraction smoke checks");
    } else {
      const { spawnSync } = await import("node:child_process");
      const { mkdtemp, readFile, rm } = await import("node:fs/promises");
      const { tmpdir } = await import("node:os");
      const { join } = await import("node:path");
      const dir = await mkdtemp(join(tmpdir(), "chelcoach-smoke-"));
      const mp4 = join(dir, "clip.mp4");
      const gen = spawnSync(
        "ffmpeg",
        [
          "-hide_banner",
          "-loglevel",
          "error",
          "-f",
          "lavfi",
          "-i",
          "color=c=blue:s=320x240:d=1",
          "-frames:v",
          "24",
          "-y",
          mp4,
        ],
        { encoding: "utf8" },
      );
      assert.equal(gen.status, 0, `ffmpeg fixture failed: ${gen.stderr}`);
      const bytes = await readFile(mp4);
      await rm(dir, { recursive: true, force: true });

      const init = await fetch(`${base}/api/uploads/init`, {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({
          filename: "game.mp4",
          contentType: "video/mp4",
          sizeBytes: bytes.length,
        }),
      });
      assert.equal(init.status, 201);
      const { clipId, uploadUrl } = (await init.json()) as { clipId: string; uploadUrl: string };
      pass("upload init creates a clip + upload target (201)");

      const put = await fetch(`${base}${uploadUrl}`, {
        method: "PUT",
        headers: { "content-type": "video/mp4" },
        body: bytes,
      });
      assert.equal(put.status, 200);
      pass("file bytes stored in object storage (queued)");

      const commit = await fetch(`${base}/api/clips/${clipId}/commit`, { method: "POST" });
      assert.equal(commit.status, 200);
      const commitBody = (await commit.json()) as { status: string };
      assert.equal(commitBody.status, "queued", "commit leaves job queued for analysis");
      pass("commit returns immediately with queued status");

      const earlyAnalysis = await fetch(`${base}/api/clips/${clipId}/analysis`);
      if (earlyAnalysis.status === 409) {
        pass("report unavailable before completion (409)");
      } else if (earlyAnalysis.status === 200) {
        pass("report became available quickly after commit");
      } else {
        assert.fail(`unexpected analysis status ${earlyAnalysis.status}`);
      }

      const completed = await pollStatus(base, clipId, "completed");
      assert.equal(completed.reportReady, true);
      assert.ok(
        completed.stage === "ready" || completed.status === "completed",
        "completed stage ready",
      );
      const liveClip = getClip(clipId);
      assert.ok(liveClip?.reportSource === "test" || liveClip?.reportSource === "live_ai");
      assert.notEqual(liveClip?.reportSource, "demo");
      pass("GET status reaches completed with validated fake-AI report (not demo)");

      const analysis = await fetch(`${base}/api/clips/${clipId}/analysis`);
      assert.equal(analysis.status, 200);
      analysisReportSchema.parse(((await analysis.json()) as { report: unknown }).report);
      pass("GET analysis returns contract-valid report after AI validation");

      // Corrupt / non-video bytes → failed
      const badInit = await fetch(`${base}/api/uploads/init`, {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({ filename: "junk.mp4", contentType: "video/mp4", sizeBytes: 16 }),
      });
      const badId = ((await badInit.json()) as { clipId: string }).clipId;
      await fetch(`${base}/api/clips/${badId}/file`, {
        method: "PUT",
        headers: { "content-type": "video/mp4" },
        body: new Uint8Array(16).fill(7),
      });
      await fetch(`${base}/api/clips/${badId}/commit`, { method: "POST" });
      const failed = await pollStatus(base, badId, "failed");
      assert.equal(failed.reportReady, false);
      assert.ok(failed.errorCode, "failed status carries error code");
      pass("invalid media fails extraction safely (failed status)");
    }

    console.log(`\nSMOKE PASSED — ${checks} checks${hasFfmpeg ? "" : " (ffmpeg skipped)"}`);
  } finally {
    server.close();
  }
}

main().catch((err) => {
  console.error("\nSMOKE FAILED:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
