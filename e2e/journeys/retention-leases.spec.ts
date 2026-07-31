import { expect, test } from "@playwright/test";
import {
  createSession,
  resetE2eControls,
  runE2eCleanup,
  setDurationOverride,
  setSimulatorScenario,
} from "../helpers/api";
import {
  openReport,
  prepareReadyToAnalyze,
  seedOwnerSession,
  submitAnalysis,
  waitForReportReady,
} from "../helpers/browser";
import {
  countActiveLeases,
  countReports,
  getJobByApplicationRequestId,
  getUploadRow,
  resetDurableState,
} from "../helpers/db";

test.beforeEach(async () => {
  await resetDurableState();
  await resetE2eControls();
  await setDurationOverride(90);
  await setSimulatorScenario("successful_short_clip");
});

test("leases released after successful analysis; cleanup deletes media and keeps report", async ({
  page,
}) => {
  const session = await createSession();
  await seedOwnerSession(page, session.token);
  await prepareReadyToAnalyze(page);
  const applicationRequestId = await submitAnalysis(page);
  await waitForReportReady(page);
  expect(await countActiveLeases()).toBe(0);
  expect(await countReports()).toBe(1);

  const job = await getJobByApplicationRequestId(applicationRequestId);
  const cleanup = await runE2eCleanup(job!.upload_id);
  expect(cleanup.deleted).toBe(1);
  const upload = await getUploadRow(job!.upload_id);
  expect(upload?.upload_status).toBe("deleted");
  expect(await countReports()).toBe(1);

  await page.goto(`/analysis/${applicationRequestId}/report`);
  await expect(page.getByTestId("report-header")).toBeVisible();
  await expect(page.getByTestId("source-media-notice")).toBeVisible();
});

test("leases released after provider failure", async ({ page }) => {
  await setSimulatorScenario("provider_failure_during_analysis");
  const session = await createSession();
  await seedOwnerSession(page, session.token);
  await prepareReadyToAnalyze(page);
  await submitAnalysis(page);
  await expect(page.getByTestId("analysis-failed-panel")).toBeVisible({ timeout: 60_000 });
  expect(await countActiveLeases()).toBe(0);
});
