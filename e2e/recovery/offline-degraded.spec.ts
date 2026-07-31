import { expect, test } from "@playwright/test";
import {
  createSession,
  resetE2eControls,
  restoreSessionToken,
  revokeSessionToken,
  setDurationOverride,
  setSimulatorScenario,
  setTimeoutInjection,
} from "../helpers/api";
import {
  prepareReadyToAnalyze,
  seedOwnerSession,
  submitAnalysis,
  waitForReportReady,
} from "../helpers/browser";
import { countAnalysisJobs, resetDurableState } from "../helpers/db";

test.beforeEach(async () => {
  await resetDurableState();
  await resetE2eControls();
  await setDurationOverride(90);
  await setSimulatorScenario("successful_short_clip");
});

test("offline pause retains last state and resumes online", async ({ page, context }) => {
  const session = await createSession();
  await seedOwnerSession(page, session.token);
  await prepareReadyToAnalyze(page);
  await submitAnalysis(page);
  await expect(page.getByTestId("analysis-status-label")).toBeVisible();

  await context.setOffline(true);
  await expect(page.getByTestId("analysis-connection-warning")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("analysis-failed-panel")).toHaveCount(0);
  const labelWhileOffline = await page.getByTestId("analysis-status-label").textContent();
  expect(labelWhileOffline).toBeTruthy();

  await context.setOffline(false);
  await waitForReportReady(page);
  expect(await countAnalysisJobs()).toBe(1);
});

test("degraded synchronization banner clears after recovery", async ({ page }) => {
  const session = await createSession();
  await seedOwnerSession(page, session.token);
  await prepareReadyToAnalyze(page);
  await submitAnalysis(page);
  await expect(page.getByTestId("analysis-status-label")).toBeVisible();

  await setTimeoutInjection("status");
  await page.getByTestId("manual-refresh").click();
  await expect(
    page.getByTestId("analysis-degraded-banner").or(page.getByTestId("analysis-connection-warning")),
  ).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("analysis-failed-panel")).toHaveCount(0);

  await setTimeoutInjection("none");
  await page.getByTestId("manual-refresh").click();
  await waitForReportReady(page);
  expect(await countAnalysisJobs()).toBe(1);
});

test("session expiration stops access; restore recovers same job without resubmit", async ({
  page,
}) => {
  const session = await createSession();
  await seedOwnerSession(page, session.token);
  await prepareReadyToAnalyze(page);
  const applicationRequestId = await submitAnalysis(page);
  await expect(page.getByTestId("analysis-status-label")).toBeVisible();

  await revokeSessionToken(session.token);
  await page.getByTestId("manual-refresh").click();
  await expect(
    page.getByTestId("analysis-access-error").or(page.getByText(/sign in|session|expired/i)),
  ).toBeVisible({ timeout: 20_000 });
  await expect(page).toHaveURL(new RegExp(`/analysis/${applicationRequestId}`));
  expect(await countAnalysisJobs()).toBe(1);

  await restoreSessionToken(session.token, session.ownerId);
  await page.evaluate((t) => localStorage.setItem("chelcoach_owner_token", t), session.token);
  await page.goto(`/analysis/${applicationRequestId}`);
  await expect(page.getByTestId("analysis-status-label")).toBeVisible({ timeout: 20_000 });
  await waitForReportReady(page);
  expect(await countAnalysisJobs()).toBe(1);
});
