import { expect, test } from "@playwright/test";
import {
  createSession,
  expireUpload,
  resetE2eControls,
  setDurationOverride,
  setMaxUploadBytes,
} from "../helpers/api";
import {
  attachNetworkGuards,
  fillGameplayProfile,
  forceIdentityFixture,
  openUpload,
  seedOwnerSession,
  uploadExpectingFailure,
  uploadFixture,
} from "../helpers/browser";
import { countAnalysisJobs, resetDurableState } from "../helpers/db";
import { API_BASE, FIXTURES } from "../helpers/env";

async function createUploadViaApi(
  token: string,
  opts: { filename: string; sizeBytes: number; body?: Buffer },
): Promise<{ status: number; uploadId?: string; uploadUrl?: string; body: unknown }> {
  const createRes = await fetch(`${API_BASE}/api/uploads`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      filename: opts.filename,
      contentType: "video/mp4",
      sizeBytes: opts.sizeBytes,
      context: {
        gameContext: {
          selectedGameTitle: "NHL 25",
          canonicalGameId: "nhl-25",
          supportStatus: "supported",
          mismatchState: "none",
        },
        playerContext: {
          platform: "xbox_series",
          controlScheme: "skill_stick",
          position: "C",
          gameMode: "eashl",
        },
        singlePlayerControl: true,
      },
      saveAsDefaults: false,
    }),
  });
  const createBody = (await createRes.json().catch(() => ({}))) as {
    uploadId?: string;
    uploadUrl?: string;
  };
  if (!createRes.ok || !createBody.uploadId || !createBody.uploadUrl) {
    return { status: createRes.status, body: createBody };
  }
  if (!opts.body) {
    return {
      status: createRes.status,
      uploadId: createBody.uploadId,
      uploadUrl: createBody.uploadUrl,
      body: createBody,
    };
  }
  const putUrl = createBody.uploadUrl.startsWith("http")
    ? createBody.uploadUrl
    : `${API_BASE}${createBody.uploadUrl}`;
  const putRes = await fetch(putUrl, {
    method: "PUT",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "video/mp4",
    },
    body: opts.body,
  });
  if (!putRes.ok) {
    return {
      status: putRes.status,
      uploadId: createBody.uploadId,
      uploadUrl: createBody.uploadUrl,
      body: await putRes.json().catch(() => ({})),
    };
  }
  const completeRes = await fetch(`${API_BASE}/api/uploads/${createBody.uploadId}/complete`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: "{}",
  });
  return {
    status: completeRes.status,
    uploadId: createBody.uploadId,
    uploadUrl: createBody.uploadUrl,
    body: await completeRes.json().catch(() => ({})),
  };
}

test.beforeEach(async () => {
  await resetDurableState();
  await resetE2eControls();
  await setDurationOverride(90);
  await setMaxUploadBytes(null);
});

test("invalid media is rejected and creates no analysis job", async ({ page }) => {
  const session = await createSession();
  await seedOwnerSession(page, session.token);
  await openUpload(page);
  await fillGameplayProfile(page);
  // Client rejects non-MP4/MOV before submit (button stays disabled).
  await page.locator('input[aria-label="Choose a game clip to upload"]').setInputFiles(FIXTURES.invalidBin);
  await expect(page.getByText(/isn't a supported clip|MP4|MOV/i).first()).toBeVisible();
  await expect(page.getByRole("button", { name: /Get My Chel Rating/i })).toBeDisabled();

  const result = await createUploadViaApi(session.token, {
    filename: "invalid.mp4",
    sizeBytes: 11,
    body: Buffer.from("not-a-video"),
  });
  expect([400, 422]).toContain(result.status);
  expect(await countAnalysisJobs()).toBe(0);
});

test("oversized stream is rejected", async ({ page }) => {
  await setMaxUploadBytes(50_000);
  const session = await createSession();
  await seedOwnerSession(page, session.token);

  const createOnly = await createUploadViaApi(session.token, {
    filename: "oversized.mp4",
    sizeBytes: 1_126_400,
  });
  if ([400, 413, 422].includes(createOnly.status)) {
    expect(await countAnalysisJobs()).toBe(0);
    return;
  }

  const putUrl = createOnly.uploadUrl!.startsWith("http")
    ? createOnly.uploadUrl!
    : `${API_BASE}${createOnly.uploadUrl!}`;
  const putRes = await fetch(putUrl, {
    method: "PUT",
    headers: {
      authorization: `Bearer ${session.token}`,
      "content-type": "video/mp4",
    },
    body: Buffer.alloc(60_000, 1),
  });
  expect([400, 413, 422]).toContain(putRes.status);
  expect(await countAnalysisJobs()).toBe(0);
  void page;
});

test("excessive duration is rejected", async ({ page }) => {
  await setDurationOverride(1801);
  const session = await createSession();
  await seedOwnerSession(page, session.token);
  await openUpload(page);
  await fillGameplayProfile(page);
  await uploadExpectingFailure(page, FIXTURES.extendedMp4);
  await expect(page.getByText(/duration|too long|exceed|30.minute|fail|error/i).first()).toBeVisible({
    timeout: 30_000,
  });
  expect(await countAnalysisJobs()).toBe(0);
});

test("expired pending upload cannot identify or analyze", async ({ page }) => {
  const session = await createSession();
  await seedOwnerSession(page, session.token);
  await openUpload(page);
  await fillGameplayProfile(page);
  await uploadFixture(page, FIXTURES.shortMp4);
  const uploadId = new URL(page.url()).searchParams.get("uploadId")!;
  await expireUpload(uploadId, "pending");

  const idRes = await fetch(`${API_BASE}/api/uploads/${uploadId}/player-identification`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${session.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ fixtureScenario: "high_confidence_center" }),
  });
  expect([410, 409, 422, 404]).toContain(idRes.status);

  const analysis = await fetch(`${API_BASE}/api/uploads/${uploadId}/analysis`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${session.token}`,
      "content-type": "application/json",
    },
    body: "{}",
  });
  expect([410, 409, 422, 404]).toContain(analysis.status);
  expect(await countAnalysisJobs()).toBe(0);
});

test("normal UI uses streamed upload route not legacy clips file", async ({ page }) => {
  const session = await createSession();
  await seedOwnerSession(page, session.token);
  const net = attachNetworkGuards(page);
  await openUpload(page);
  await fillGameplayProfile(page);
  await uploadFixture(page, FIXTURES.shortMp4);
  await forceIdentityFixture(page, "high_confidence_center");
  net.assertNoLegacyUpload();
});
