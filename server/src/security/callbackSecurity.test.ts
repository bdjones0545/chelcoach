import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { AddressInfo } from "node:net";
import { createApp } from "../app";
import { resetChelCoachConfigCacheForTests } from "../config/chelcoachConfig";
import {
  InMemoryAnalysisJobRepository,
  resetAnalysisJobRepositoryForTests,
} from "../provider/jobs/jobRepository";
import {
  SCOTTY_CALLBACK_MAX_SKEW_SECONDS,
  signScottyCallback,
} from "./callbackSignature";

const SECRET = "callback-test-secret-value-with-sufficient-entropy";

function callback(eventId = "evt-secure-1") {
  return {
    eventId,
    eventType: "status_changed",
    contractVersion: "1.0.0",
    externalJobId: "external-secure-1",
    applicationRequestId: "application-secure-1",
    status: "analyzing_gameplay",
    occurredAt: new Date().toISOString(),
    sequenceNumber: 4,
  };
}

async function withServer(fn: (base: string) => Promise<void>): Promise<void> {
  const server = createApp().listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    await fn(base);
  } finally {
    server.close();
  }
}

function signedHeaders(rawBody: Buffer, timestamp = String(Math.floor(Date.now() / 1000))) {
  return {
    "content-type": "application/json",
    "x-scotty-timestamp": timestamp,
    "x-scotty-signature": signScottyCallback(SECRET, timestamp, rawBody),
  };
}

async function post(base: string, rawBody: Buffer, headers: Record<string, string> = {}) {
  return fetch(`${base}/api/internal/scotty/callbacks`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: rawBody,
  });
}

beforeEach(() => {
  process.env.NODE_ENV = "test";
  process.env.CHELCOACH_SKIP_CONFIG_VALIDATION = "1";
  process.env.CHELCOACH_FORCE_MEMORY_REPOS = "1";
  process.env.CHELCOACH_SCOTTY_CALLBACKS_ENABLED = "1";
  process.env.CHELCOACH_CALLBACK_SECRET = SECRET;
  resetChelCoachConfigCacheForTests();
  resetAnalysisJobRepositoryForTests();
});

afterEach(() => {
  delete process.env.CHELCOACH_SCOTTY_CALLBACKS_ENABLED;
  delete process.env.CHELCOACH_CALLBACK_SECRET;
  delete process.env.CHELCOACH_SKIP_CONFIG_VALIDATION;
  resetChelCoachConfigCacheForTests();
});

describe("Scotty callback authentication and replay safety", () => {
  it("accepts a valid exact-body HMAC and dedupes a sequential retry", async () => {
    await withServer(async (base) => {
      const body = Buffer.from(JSON.stringify(callback()));
      const first = await post(base, body, signedHeaders(body));
      assert.equal(first.status, 202);
      assert.equal((await first.json() as { reason: string }).reason, "callback_processing_disabled");
      const retry = await post(base, body, signedHeaders(body));
      assert.equal(retry.status, 202);
      assert.equal((await retry.json() as { reason: string }).reason, "duplicate_event_idempotent");
    });
  });

  it("rejects missing, malformed, and incorrect authentication headers", async () => {
    await withServer(async (base) => {
      const body = Buffer.from(JSON.stringify(callback()));
      assert.equal((await post(base, body)).status, 401);
      assert.equal((await post(base, body, { "x-scotty-timestamp": "nope", "x-scotty-signature": "v1=xyz" })).status, 401);
      assert.equal((await post(base, body, { ...signedHeaders(body), "x-scotty-signature": `v1=${"0".repeat(64)}` })).status, 401);
    });
  });

  it("rejects body alteration and stale timestamps", async () => {
    await withServer(async (base) => {
      const body = Buffer.from(JSON.stringify(callback()));
      const altered = Buffer.from(JSON.stringify({ ...callback(), status: "completed" }));
      assert.equal((await post(base, altered, signedHeaders(body))).status, 401);
      const stale = String(Math.floor(Date.now() / 1000) - SCOTTY_CALLBACK_MAX_SKEW_SECONDS - 1);
      assert.equal((await post(base, body, signedHeaders(body, stale))).status, 401);
    });
  });

  it("does not let invalid or malformed callbacks poison a valid delivery ID", async () => {
    await withServer(async (base) => {
      const body = Buffer.from(JSON.stringify(callback("evt-not-poisoned")));
      assert.equal((await post(base, body, { ...signedHeaders(body), "x-scotty-signature": `v1=${"f".repeat(64)}` })).status, 401);
      assert.equal((await post(base, Buffer.from("{}"), signedHeaders(Buffer.from("{}")))).status, 400);
      const valid = await post(base, body, signedHeaders(body));
      assert.equal(valid.status, 202);
      assert.equal((await valid.json() as { reason: string }).reason, "callback_processing_disabled");
    });
  });

  it("allows only one concurrent delivery to claim an event", async () => {
    await withServer(async (base) => {
      const body = Buffer.from(JSON.stringify(callback("evt-concurrent")));
      const [a, b] = await Promise.all([
        post(base, body, signedHeaders(body)),
        post(base, body, signedHeaders(body)),
      ]);
      assert.deepEqual([a.status, b.status].sort(), [202, 202]);
      const reasons = await Promise.all([a.json(), b.json()]) as Array<{ reason: string }>;
      assert.equal(reasons.filter((r) => r.reason === "callback_processing_disabled").length, 1);
      assert.equal(reasons.filter((r) => r.reason.startsWith("duplicate_event_")).length, 1);
    });
  });

  it("releases a failed claim so a legitimate provider retry can win", async () => {
    const repo = new InMemoryAnalysisJobRepository();
    const input = { eventId: "evt-retry", provider: "scotty" as const, externalJobId: "ext", sequenceNumber: 1 };
    assert.equal((await repo.claimCallbackEvent(input)).claimed, true);
    await repo.releaseCallbackEvent("scotty", input.eventId);
    assert.equal((await repo.claimCallbackEvent(input)).claimed, true);
  });
});
