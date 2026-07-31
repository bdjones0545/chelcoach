import { expect, test } from "@playwright/test";
import {
  createSession,
  postCallback,
  reconcile,
  resetE2eControls,
  setDurationOverride,
} from "../helpers/api";
import {
  assertNoLeaks,
  attachNetworkGuards,
  prepareReadyToAnalyze,
  seedOwnerSession,
  submitAnalysis,
  waitForReportReady,
} from "../helpers/browser";
import { countReports, resetDurableState } from "../helpers/db";

test.beforeEach(async () => {
  await resetDurableState();
  await resetE2eControls();
  await setDurationOverride(90);
});

test("browser never calls Scotty/Anthropic and reconcile requires secret", async ({ page }) => {
  const session = await createSession();
  await seedOwnerSession(page, session.token);
  const net = attachNetworkGuards(page);
  await prepareReadyToAnalyze(page);
  await submitAnalysis(page);
  await waitForReportReady(page);
  await assertNoLeaks(page);
  net.assertChelCoachOnly();

  const unauthorized = await reconcile(10);
  expect(unauthorized.status).toBe(404);

  const wrong = await reconcile(10, "wrong-secret");
  expect(wrong.status).toBe(404);

  const ok = await reconcile(10, process.env.CHELCOACH_RECONCILE_SECRET || "e2e-reconcile-secret");
  expect(ok.status).toBe(200);
  expect(ok.body).toHaveProperty("examined");

  // Callbacks remain disabled.
  const cb = await postCallback(
    {
      eventId: "evt_test_1",
      contractVersion: "1",
      externalJobId: "sim_x",
      applicationRequestId: "req_x",
      sequenceNumber: 1,
      status: "completed",
      occurredAt: new Date().toISOString(),
    },
    "sig",
  );
  expect(cb.status).toBe(404);
});

test("reconciliation does not duplicate reports", async ({ page }) => {
  const session = await createSession();
  await seedOwnerSession(page, session.token);
  await prepareReadyToAnalyze(page);
  await submitAnalysis(page);
  await waitForReportReady(page);
  const before = await countReports();
  expect(before).toBe(1);
  await reconcile(25, process.env.CHELCOACH_RECONCILE_SECRET || "e2e-reconcile-secret");
  expect(await countReports()).toBe(1);
});
