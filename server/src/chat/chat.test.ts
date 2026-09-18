import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createApp } from "../app";
import { createOwnerSession, resetSessionsForTests } from "../auth/session";
import { resetChelCoachConfigCacheForTests } from "../config/chelcoachConfig";
import { FakeConfirmationFrameExtractor, setConfirmationFrameExtractorForTests } from "../identification/extractor";
import { resetIdentificationRepositoryForTests } from "../identification/repository";
import { FakeMediaInspector, setMediaInspectorForTests } from "../media/inspector";
import { resetMediaObjectStorageForTests } from "../mediaStorage";
import { resetProfileRepositoryForTests } from "../profile/repository";
import { ProviderError } from "../provider/errors";
import { resetScottyProviderForTests, setScottyProviderForTests } from "../provider/factory";
import { FakeScottyProvider } from "../provider/fakeProvider";
import { getAnalysisJobRepository, resetAnalysisJobRepositoryForTests } from "../provider/jobs/jobRepository";
import type { ScottyProvider } from "../provider/types";
import { resetRetentionPolicyCacheForTests } from "../retention/policy";
import { minimalScottyReport } from "../../../shared/scotty/fixtures";
import { resetUploadRepositoryForTests } from "../uploads/repository";
import { buildReportContext } from "./service";
import { resetChatRepositoryForTests } from "./repository";

const uploadContext = {
  gameContext: { selectedGameTitle: "NHL 27", canonicalGameId: "nhl-27", supportStatus: "supported", mismatchState: "none" },
  playerContext: { platform: "xbox_series", controlScheme: "skill_stick", position: "C", gameMode: "eashl", jerseyNumber: 17, indicatorColor: "blue", teamSide: "home" },
  singlePlayerControl: true,
};

let server: ReturnType<ReturnType<typeof createApp>["listen"]> | null = null;
let base = "";

async function boot(provider: ScottyProvider) {
  resetSessionsForTests();
  resetUploadRepositoryForTests();
  resetProfileRepositoryForTests();
  resetMediaObjectStorageForTests();
  resetRetentionPolicyCacheForTests();
  resetIdentificationRepositoryForTests();
  resetAnalysisJobRepositoryForTests();
  resetChatRepositoryForTests();
  setMediaInspectorForTests(new FakeMediaInspector({ mimeType: "video/mp4", byteSize: 2048, durationSeconds: 90, width: 640, height: 360, hasVideoStream: true }));
  setConfirmationFrameExtractorForTests(new FakeConfirmationFrameExtractor());
  const app = createApp();
  setScottyProviderForTests(provider); // createApp() re-selects the provider at boot
  server = app.listen(0);
  await new Promise<void>((r) => server!.once("listening", () => r()));
  base = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
}

async function completedAnalysis(token: string): Promise<string> {
  const h = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const created = (await (await fetch(`${base}/api/uploads`, { method: "POST", headers: h, body: JSON.stringify({ filename: "g.mp4", contentType: "video/mp4", sizeBytes: 2048, context: uploadContext }) })).json()) as { uploadId: string; uploadUrl: string };
  await fetch(`${base}${created.uploadUrl}`, { method: "PUT", headers: { authorization: `Bearer ${token}`, "content-type": "video/mp4" }, body: Buffer.alloc(2048, 1) });
  process.env.CHELCOACH_ALLOW_IDENTITY_FIXTURES = "1";
  await fetch(`${base}/api/uploads/${created.uploadId}/player-identification`, { method: "POST", headers: h, body: JSON.stringify({ fixtureScenario: "high_confidence_center" }) });
  const submit = await fetch(`${base}/api/uploads/${created.uploadId}/analysis`, { method: "POST", headers: h, body: "{}" });
  assert.equal(submit.status, 202, await submit.clone().text());
  const { applicationRequestId } = (await submit.json()) as { applicationRequestId: string };

  // Persist a completed report the way the sync path would.
  const repo = getAnalysisJobRepository();
  const job = (await repo.getByApplicationRequestId(applicationRequestId))!;
  const report = minimalScottyReport({
    uploadId: job.uploadId,
    playerSpecificObservations: [
      { timestampSec: 20, category: "positioning", observedAction: "late slot arrival on the weak side", attributionExplanation: "blue indicator, #17", coachingInterpretation: "Arrive a stride earlier.", confidence: "moderate" },
    ],
  });
  await repo.completeWithReport({
    applicationRequestId,
    expectedVersion: job.version,
    report: {
      id: "rep-1", applicationRequestId, jobId: job.id, externalJobId: job.externalJobId ?? "ext-1", uploadId: job.uploadId, ownerId: job.ownerId,
      provider: job.provider, contractVersion: "1.0.0", reportVersion: report.reportVersion, rubricVersion: report.rubricVersion,
      strategyKnowledgeVersion: report.strategyKnowledgeVersion, controlKnowledgeVersion: report.controlKnowledgeVersion,
      report, contentChecksum: createHash("sha256").update(JSON.stringify(report)).digest("hex"),
      schemaValidatedAt: new Date().toISOString(), providerGeneratedAt: new Date().toISOString(), persistedAt: new Date().toISOString(),
    },
    completedAt: new Date().toISOString(),
    statusSequenceNumber: 10,
    providerSequenceNumber: 10,
    eventSource: "provider_poll",
  });
  return applicationRequestId;
}

beforeEach(() => {
  resetChelCoachConfigCacheForTests();
});

afterEach(() => {
  server?.close();
  server = null;
  setMediaInspectorForTests(undefined);
  resetScottyProviderForTests();
  delete process.env.CHELCOACH_MAX_DAILY_CHAT_MESSAGES_PER_USER;
  resetChelCoachConfigCacheForTests();
});

describe("Ask Scottie", () => {
  it("answers from the report, persists both turns, and returns the conversation", async () => {
    await boot(new FakeScottyProvider("accept"));
    const token = createOwnerSession().token;
    const id = await completedAnalysis(token);
    const h = { authorization: `Bearer ${token}`, "content-type": "application/json" };

    const empty = await fetch(`${base}/api/analysis/${id}/chat`, { headers: h });
    assert.equal(empty.status, 200);
    assert.deepEqual(await empty.json(), { messages: [] });

    const res = await fetch(`${base}/api/analysis/${id}/chat`, { method: "POST", headers: h, body: JSON.stringify({ message: "  What should I fix   first? " }) });
    assert.equal(res.status, 200, await res.clone().text());
    const body = (await res.json()) as { reply: { role: string; content: string }; messages: Array<{ role: string; content: string }> };
    assert.equal(body.reply.role, "assistant");
    assert.match(body.reply.content, /late slot arrival on the weak side around 20s/);
    assert.deepEqual(body.messages.map((m) => m.role), ["user", "assistant"]);
    assert.equal(body.messages[0]!.content, "What should I fix first?", "whitespace normalised");

    const again = (await (await fetch(`${base}/api/analysis/${id}/chat`, { headers: h })).json()) as { messages: unknown[] };
    assert.equal(again.messages.length, 2, "history survives");
  });

  it("is owner-only and requires a completed report", async () => {
    await boot(new FakeScottyProvider("accept"));
    const owner = createOwnerSession().token;
    const other = createOwnerSession().token;
    const id = await completedAnalysis(owner);
    const stranger = await fetch(`${base}/api/analysis/${id}/chat`, { method: "POST", headers: { authorization: `Bearer ${other}`, "content-type": "application/json" }, body: JSON.stringify({ message: "hi" }) });
    assert.equal(stranger.status, 403, "same answer the analysis routes give another owner");
    const anon = await fetch(`${base}/api/analysis/${id}/chat`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: "hi" }) });
    assert.equal(anon.status, 401);
    const bad = await fetch(`${base}/api/analysis/${id}/chat`, { method: "POST", headers: { authorization: `Bearer ${owner}`, "content-type": "application/json" }, body: JSON.stringify({ message: "   " }) });
    assert.equal(bad.status, 400);
  });

  it("enforces the durable daily cap and never charges a turn the provider failed to answer", async () => {
    process.env.CHELCOACH_MAX_DAILY_CHAT_MESSAGES_PER_USER = "2";
    resetChelCoachConfigCacheForTests();
    let fail = false;
    const flaky = new Proxy(new FakeScottyProvider("accept"), {
      get: (t, k) =>
        k === "chat"
          ? async (input: Parameters<NonNullable<ScottyProvider["chat"]>>[0]) => {
              if (fail) throw new ProviderError("PROVIDER_UNAVAILABLE", "down", "network", { provider: "fake", retryable: true });
              return t.chat!(input);
            }
          : Reflect.get(t, k),
    }) as ScottyProvider;
    await boot(flaky);
    const token = createOwnerSession().token;
    const id = await completedAnalysis(token);
    const h = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    const ask = (m: string) => fetch(`${base}/api/analysis/${id}/chat`, { method: "POST", headers: h, body: JSON.stringify({ message: m }) });

    assert.equal((await ask("one")).status, 200);
    fail = true;
    const down = await ask("two");
    assert.equal(down.status, 503);
    assert.equal(((await down.json()) as { error: string }).error, "PROVIDER_UNAVAILABLE");
    fail = false;
    assert.equal((await ask("two again")).status, 200, "the failed turn was not counted");
    const capped = await ask("three");
    assert.equal(capped.status, 429);
    const history = (await (await fetch(`${base}/api/analysis/${id}/chat`, { headers: h })).json()) as { messages: unknown[] };
    assert.equal(history.messages.length, 4, "only answered turns are stored");
  });

  it("sends the provider only the report, never storage keys or ids", () => {
    const ctx = buildReportContext(minimalScottyReport());
    const s = JSON.stringify(ctx);
    for (const k of ["reportId", "jobId", "uploadId", "storageObjectKey", "signedUrl"]) assert.ok(!s.includes(`"${k}"`), k);
    assert.ok("playerSpecificObservations" in ctx && "uncertaintyDisclosures" in ctx);
  });
});
