import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cancelAnalysis,
  getAnalysisReport,
  getAnalysisStatus,
  submitProviderPlayerConfirmation,
} from "./analysisClient";
import { AnalysisApiError } from "./analysisClientErrors";
import { makeStatus } from "../test/analysisJobFixtures";

vi.mock("./scottyUploadApi", () => ({
  ensureOwnerSession: vi.fn(async () => "test-token"),
}));

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("analysisClient", () => {
  it("validates status response and uses no-store cache mode", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify(makeStatus()), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const job = await getAnalysisStatus("req-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
    expect(job.status).toBe("analyzing_gameplay");
    expect(fetchMock).toHaveBeenCalled();
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(init.cache).toBe("no-store");
  });

  it("accepts abort signal", async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn(async (_url, init) => {
      expect(init?.signal).toBe(controller.signal);
      return new Response(JSON.stringify(makeStatus()), { status: 200 });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    await getAnalysisStatus("req-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", controller.signal);
  });

  it("normalizes session expiration", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ error: "UNAUTHORIZED", message: "nope" }), { status: 401 }),
    ) as unknown as typeof fetch;
    await expect(getAnalysisStatus("req-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee")).rejects.toMatchObject({
      clientError: { type: "session_expired", retryable: false },
    });
  });

  it("uses generic access message for forbidden/not-found (no ownership leak)", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ error: "NOT_FOUND", message: "owned by other" }), {
        status: 404,
      }),
    ) as unknown as typeof fetch;
    try {
      await getAnalysisStatus("req-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(AnalysisApiError);
      expect((err as AnalysisApiError).clientError.message).toBe(
        "We could not access this analysis.",
      );
      expect((err as AnalysisApiError).clientError.message).not.toMatch(/owned|other user/i);
    }
  });

  it("rejects malformed request ids without calling fetch", async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    await expect(getAnalysisStatus("../etc/passwd")).rejects.toMatchObject({
      clientError: { type: "malformed_id" },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("validates report response", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ not: "a report" }), { status: 200 }),
    ) as unknown as typeof fetch;
    await expect(
      getAnalysisReport("req-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"),
    ).rejects.toMatchObject({
      clientError: { type: "invalid_response" },
    });
  });

  it("cancel and provider confirmation post to durable endpoints", async () => {
    const urls: string[] = [];
    globalThis.fetch = vi.fn(async (url) => {
      urls.push(String(url));
      return new Response(JSON.stringify(makeStatus({ status: "cancelled", terminal: true, pollAfterMs: null })), {
        status: 200,
      });
    }) as unknown as typeof fetch;
    await cancelAnalysis("req-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
    await submitProviderPlayerConfirmation("req-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", {
      selectedCandidateId: "cand-1",
    });
    expect(urls[0]).toMatch(/\/api\/analysis\/.+\/cancel$/);
    expect(urls[1]).toMatch(/\/api\/analysis\/.+\/player-confirmation$/);
  });
});
