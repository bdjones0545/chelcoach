import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";
import {
  enqueueExtraction,
  extractionQueueSnapshot,
  resetExtractionQueueForTests,
  setExtractionRunnerForTests,
  shutdownExtractionQueue,
} from "./extractionQueue";
import {
  commitClip,
  createClip,
  getClip,
  markUploaded,
  resetStoreForTests,
} from "../store";
import { resetStorageForTests, getStorage } from "../storage";
import type { RunProcessResult } from "../media/processRunner";

function ok(stdout = ""): RunProcessResult {
  return { code: 0, stdout, stderr: "", timedOut: false, signal: null };
}

async function waitForTerminal(clipId: string, timeoutMs = 2_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const clip = getClip(clipId);
    if (clip?.status === "complete" || clip?.status === "failed") return;
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe("extractionQueue", () => {
  beforeEach(() => {
    resetStoreForTests();
    resetExtractionQueueForTests();
    resetStorageForTests();
    process.env.STORAGE_BACKEND = "memory";
  });

  afterEach(async () => {
    shutdownExtractionQueue();
    await new Promise((r) => setTimeout(r, 50));
    resetExtractionQueueForTests();
    setExtractionRunnerForTests(undefined);
  });

  it("suppresses duplicate enqueue for the same clip", async () => {
    const clip = createClip({ filename: "a.mp4", contentType: "video/mp4", sizeBytes: 4 });
    await getStorage().put(clip.storageKey, Buffer.from([1, 2, 3, 4]), "video/mp4");
    markUploaded(clip.id, 4);
    commitClip(clip.id);

    let calls = 0;
    setExtractionRunnerForTests(async () => {
      calls += 1;
      await new Promise((r) => setTimeout(r, 150));
      return ok("{}");
    });

    enqueueExtraction(clip.id);
    enqueueExtraction(clip.id);
    enqueueExtraction(clip.id);

    const snap = extractionQueueSnapshot();
    assert.equal(snap.waiting + snap.inFlight.length, 1);

    await waitForTerminal(clip.id);
    // Runner may be invoked multiple times (ffprobe + frames) for one job — but only one job.
    assert.ok(calls >= 1);
  });

  it("marks the job failed when the injectable runner times out", async () => {
    const clip = createClip({ filename: "a.mp4", contentType: "video/mp4", sizeBytes: 4 });
    await getStorage().put(clip.storageKey, Buffer.from([1, 2, 3, 4]), "video/mp4");
    markUploaded(clip.id, 4);
    commitClip(clip.id);

    setExtractionRunnerForTests(async () => ({
      code: null,
      stdout: "",
      stderr: "timeout",
      timedOut: true,
      signal: "SIGKILL",
    }));

    enqueueExtraction(clip.id);
    await waitForTerminal(clip.id);
    const updated = getClip(clip.id);
    assert.equal(updated?.status, "failed");
    assert.equal(updated?.errorCode, "process_timeout");
  });
});
