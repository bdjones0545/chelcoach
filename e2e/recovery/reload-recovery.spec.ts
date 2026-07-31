import { expect, test } from "@playwright/test";
import {
  createSession,
  resetE2eControls,
  setDurationOverride,
  setSimulatorScenario,
} from "../helpers/api";
import {
  prepareReadyToAnalyze,
  seedOwnerSession,
  submitAnalysis,
  waitForReportReady,
  waitForStatus,
} from "../helpers/browser";
import {
  countAnalysisJobs,
  getJobByApplicationRequestId,
  resetDurableState,
} from "../helpers/db";

test.beforeEach(async () => {
  await resetDurableState();
  await resetE2eControls();
  await setDurationOverride(90);
  await setSimulatorScenario("successful_short_clip");
});

test("browser closure recovery via durable URL + same session", async ({ browser }) => {
  const session = await createSession();
  const context = await browser.newContext();
  const page = await context.newPage();
  await seedOwnerSession(page, session.token);
  await prepareReadyToAnalyze(page);
  const applicationRequestId = await submitAnalysis(page);
  const durableUrl = page.url();
  await context.close();

  // Allow simulator lifecycle to continue server-side.
  await new Promise((r) => setTimeout(r, 2500));

  const context2 = await browser.newContext();
  const page2 = await context2.newPage();
  await seedOwnerSession(page2, session.token);
  await page2.goto(durableUrl);
  await expect(page2).toHaveURL(new RegExp(`/analysis/${applicationRequestId}`));
  await expect(page2.getByTestId("analysis-status-label")).toBeVisible({ timeout: 20_000 });
  await waitForReportReady(page2);
  expect(await countAnalysisJobs()).toBe(1);
  await context2.close();
});

test("direct status-route recovery mid-flight", async ({ page }) => {
  const session = await createSession();
  await seedOwnerSession(page, session.token);
  await prepareReadyToAnalyze(page);
  const applicationRequestId = await submitAnalysis(page);
  await page.goto(`/analysis/${applicationRequestId}`);
  await expect(page.getByTestId("analysis-status-label")).toBeVisible();
  await waitForReportReady(page);
  const row = await getJobByApplicationRequestId(applicationRequestId);
  expect(row?.canonical_status).toBe("completed");
});

test("direct report-route recovery after completion", async ({ page }) => {
  const session = await createSession();
  await seedOwnerSession(page, session.token);
  await prepareReadyToAnalyze(page);
  const applicationRequestId = await submitAnalysis(page);
  await waitForReportReady(page);
  await page.goto(`/analysis/${applicationRequestId}/report`);
  await expect(page.getByTestId("report-header")).toBeVisible({ timeout: 30_000 });
});

test("duplicate tabs observe shared cancellation", async ({ browser }) => {
  await setSimulatorScenario("cancel_during_analysis");
  const session = await createSession();
  const ctx = await browser.newContext();
  const pageA = await ctx.newPage();
  await seedOwnerSession(pageA, session.token);
  await prepareReadyToAnalyze(pageA);
  const applicationRequestId = await submitAnalysis(pageA);

  const pageB = await ctx.newPage();
  await seedOwnerSession(pageB, session.token);
  await pageB.goto(`/analysis/${applicationRequestId}`);
  await expect(pageB.getByTestId("analysis-status-label")).toBeVisible();

  await expect(pageA.getByTestId("cancel-analysis")).toBeVisible({ timeout: 20_000 });
  await pageA.getByTestId("cancel-analysis").click();
  await waitForStatus(pageA, /cancel/i, 45_000);
  await waitForStatus(pageB, /cancel/i, 45_000);
  expect(await countAnalysisJobs()).toBe(1);
  await ctx.close();
});

test("reload matrix samples active + terminal states", async ({ page }) => {
  const session = await createSession();
  await seedOwnerSession(page, session.token);
  await prepareReadyToAnalyze(page);
  const applicationRequestId = await submitAnalysis(page);

  // Active sample
  await page.reload();
  await expect(page).toHaveURL(new RegExp(`/analysis/${applicationRequestId}$`));
  await expect(page.getByTestId("analysis-status-label")).toBeVisible();

  await waitForReportReady(page);
  // Completed sample
  await page.reload();
  await expect(page.getByTestId("view-coaching-report")).toBeVisible();
  expect(await countAnalysisJobs()).toBe(1);
});
