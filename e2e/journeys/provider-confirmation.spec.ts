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
} from "../helpers/browser";
import { countAnalysisJobs, countSimulatorJobs, resetDurableState } from "../helpers/db";

test.beforeEach(async () => {
  await resetDurableState();
  await resetE2eControls();
  await setDurationOverride(90);
  await setSimulatorScenario("player_confirmation_required");
});

test("provider-level confirmation pauses, recovers on reload, and resumes once", async ({
  page,
}) => {
  const session = await createSession();
  await seedOwnerSession(page, session.token);
  await prepareReadyToAnalyze(page, { identityFixture: "high_confidence_center" });

  const applicationRequestId = await submitAnalysis(page);
  await expect(page.getByTestId("provider-confirmation-panel")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId("analysis-status-label")).toBeVisible();

  await page.waitForTimeout(800);

  await page.reload();
  await expect(page).toHaveURL(new RegExp(`/analysis/${applicationRequestId}`));
  await expect(page.getByTestId("provider-confirmation-panel")).toBeVisible({ timeout: 30_000 });

  const radios = page.getByTestId("provider-confirmation-panel").getByRole("radio");
  await expect(radios.first()).toBeVisible({ timeout: 20_000 });
  await radios.first().click();
  await page.getByRole("button", { name: /Confirm player and continue/i }).click();

  // Confirmation should clear the pause panel; refresh if sync is temporarily degraded.
  await expect(page.getByTestId("provider-confirmation-panel")).toHaveCount(0, { timeout: 30_000 });
  if (await page.getByTestId("analysis-degraded-banner").isVisible().catch(() => false)) {
    await page.getByTestId("manual-refresh").click();
  }
  await waitForReportReady(page);
  expect(await countAnalysisJobs()).toBe(1);
  expect(await countSimulatorJobs()).toBe(1);
});
