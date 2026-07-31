import { expect, test } from "@playwright/test";
import {
  apiJson,
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
import { getJobByApplicationRequestId, resetDurableState } from "../helpers/db";

test.beforeEach(async () => {
  await resetDurableState();
  await resetE2eControls();
  await setDurationOverride(90);
});

test("cancellation during analysis becomes terminal and blocks report", async ({ page }) => {
  await setSimulatorScenario("cancel_during_analysis");
  const session = await createSession();
  await seedOwnerSession(page, session.token);
  await prepareReadyToAnalyze(page);

  const applicationRequestId = await submitAnalysis(page);
  await expect(page.getByTestId("cancel-analysis")).toBeVisible({ timeout: 20_000 });

  // Wait until analyzing when possible, then cancel.
  await page.waitForTimeout(400);
  await page.getByTestId("cancel-analysis").click();
  await expect(page.getByTestId("cancellation-pending").or(page.getByTestId("analysis-cancelled-panel")))
    .toBeVisible({ timeout: 20_000 });

  // Duplicate click should not invent a second cancel path / crash.
  if (await page.getByTestId("cancel-analysis").isVisible().catch(() => false)) {
    await page.getByTestId("cancel-analysis").click({ trial: true }).catch(() => undefined);
  }

  await waitForStatus(page, /cancel/i, 45_000);
  await expect(page.getByTestId("view-coaching-report")).toHaveCount(0);

  await page.reload();
  await waitForStatus(page, /cancel/i, 20_000);

  const report = await apiJson(`/api/analysis/${applicationRequestId}/report`, {
    token: session.token,
  });
  expect([404, 409, 410, 422]).toContain(report.status);

  const row = await getJobByApplicationRequestId(applicationRequestId);
  expect(row?.canonical_status).toBe("cancelled");
});

test("completed job cannot be cancelled", async ({ page }) => {
  await setSimulatorScenario("successful_short_clip");
  const session = await createSession();
  await seedOwnerSession(page, session.token);
  await prepareReadyToAnalyze(page);
  const applicationRequestId = await submitAnalysis(page);
  await waitForReportReady(page);
  await expect(page.getByTestId("cancel-analysis")).toHaveCount(0);

  const cancel = await apiJson(`/api/analysis/${applicationRequestId}/cancel`, {
    method: "POST",
    token: session.token,
    body: JSON.stringify({ reason: "too late" }),
  });
  expect([409, 422]).toContain(cancel.status);

  const row = await getJobByApplicationRequestId(applicationRequestId);
  expect(row?.canonical_status).toBe("completed");
  expect(row?.report_available).toBe(true);
});
