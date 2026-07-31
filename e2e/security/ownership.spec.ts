import { expect, test } from "@playwright/test";
import { apiJson, createSession, resetE2eControls, setDurationOverride } from "../helpers/api";
import {
  prepareReadyToAnalyze,
  seedOwnerSession,
  submitAnalysis,
  waitForReportReady,
} from "../helpers/browser";
import { resetDurableState } from "../helpers/db";

test.beforeEach(async () => {
  await resetDurableState();
  await resetE2eControls();
  await setDurationOverride(90);
});

test("second user cannot read status, report, cancel, or confirm", async ({ page }) => {
  const userA = await createSession();
  const userB = await createSession();
  await seedOwnerSession(page, userA.token);
  await prepareReadyToAnalyze(page);
  const applicationRequestId = await submitAnalysis(page);
  await waitForReportReady(page);

  const job = await apiJson<{ uploadId?: string }>(`/api/analysis/${applicationRequestId}`, {
    token: userA.token,
  });
  const uploadId = (job.body as { uploadId?: string }).uploadId!;

  const statusB = await apiJson(`/api/analysis/${applicationRequestId}`, { token: userB.token });
  expect([403, 404]).toContain(statusB.status);

  const reportB = await apiJson(`/api/analysis/${applicationRequestId}/report`, {
    token: userB.token,
  });
  expect([403, 404]).toContain(reportB.status);

  const cancelB = await apiJson(`/api/analysis/${applicationRequestId}/cancel`, {
    method: "POST",
    token: userB.token,
    body: JSON.stringify({}),
  });
  expect([403, 404]).toContain(cancelB.status);

  const confirmB = await apiJson(`/api/analysis/${applicationRequestId}/player-confirmation`, {
    method: "POST",
    token: userB.token,
    body: JSON.stringify({ selectedCandidateId: "x" }),
  });
  expect([403, 404]).toContain(confirmB.status);

  const uploadB = await apiJson(`/api/uploads/${uploadId}`, { token: userB.token });
  expect([403, 404]).toContain(uploadB.status);

  const idB = await apiJson(`/api/uploads/${uploadId}/player-identification`, {
    token: userB.token,
  });
  expect([403, 404]).toContain(idB.status);

  // Bodies must not reveal the other owner's identifiers.
  const leaked = JSON.stringify({ statusB, reportB, cancelB, confirmB, uploadB, idB });
  expect(leaked).not.toContain(userA.ownerId);
});
