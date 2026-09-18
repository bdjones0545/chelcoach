import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { AddressInfo } from "node:net";
import { createApp } from "../app";
import { FakeScottyProvider } from "../provider/fakeProvider";
import { resetScottyProviderForTests, setScottyProviderForTests } from "../provider/factory";
import type { ScottyProvider, ScottyProviderHealth } from "../provider/types";

async function withServer(provider: ScottyProvider, fn: (base: string) => Promise<void>) {
  const app = createApp();
  // createApp() installs the configured provider at boot (as production does); override after.
  setScottyProviderForTests(provider);
  const server = app.listen(0);
  await new Promise<void>((r) => server.once("listening", () => r()));
  const { port } = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    server.close();
  }
}

function withHealth(status: ScottyProviderHealth["status"] | "hang" | "throw"): ScottyProvider {
  const base = new FakeScottyProvider("accept");
  const health = async (): Promise<ScottyProviderHealth> => {
    if (status === "hang") return new Promise(() => undefined);
    if (status === "throw") throw new Error("boom");
    return {
      provider: "scotty",
      configured: true,
      reachable: status === "healthy",
      contractCompatible: true,
      status,
      checkedAt: new Date().toISOString(),
      message: status,
    };
  };
  return new Proxy(base, { get: (t, k) => (k === "health" ? health : Reflect.get(t, k)) }) as ScottyProvider;
}

afterEach(() => {
  resetScottyProviderForTests();
});

describe("public readiness gate asks the gateway", () => {
  it("is enabled only when the provider reports healthy", async () => {
    await withServer(withHealth("healthy"), async (base) => {
      const res = await fetch(`${base}/api/health/readiness`);
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { analysisSubmission: "enabled" });
    });
  });

  it("stays open on degraded (busy) but closes on unavailable, misconfigured, or a throwing probe", async () => {
    await withServer(withHealth("degraded"), async (base) => {
      assert.equal((await fetch(`${base}/api/health/readiness`)).status, 200);
    });
    for (const s of ["unavailable", "misconfigured", "throw"] as const) {
      await withServer(withHealth(s), async (base) => {
        const res = await fetch(`${base}/api/health/readiness`);
        assert.equal(res.status, 503, s);
        assert.deepEqual(await res.json(), { analysisSubmission: "disabled" });
      });
    }
  });

  it("does not hang on a silent gateway — fails closed after the probe timeout", async () => {
    await withServer(withHealth("hang"), async (base) => {
      const started = Date.now();
      const res = await fetch(`${base}/api/health/readiness`);
      assert.equal(res.status, 503);
      assert.ok(Date.now() - started < 6_000, "answered within the probe budget");
    });
  });
});
