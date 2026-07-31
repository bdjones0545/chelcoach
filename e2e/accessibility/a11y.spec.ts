import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import {
  createSession,
  resetE2eControls,
  setDurationOverride,
  setSimulatorScenario,
} from "../helpers/api";
import {
  fillGameplayProfile,
  forceIdentityFixture,
  openReport,
  openUpload,
  prepareReadyToAnalyze,
  seedOwnerSession,
  submitAnalysis,
  uploadFixture,
  waitForReportReady,
  waitForStatus,
} from "../helpers/browser";
import { resetDurableState } from "../helpers/db";
import { FIXTURES } from "../helpers/env";

async function expectNoSeriousA11y(page: import("@playwright/test").Page, label: string) {
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa"])
    .analyze();
  const serious = results.violations.filter((v) =>
    ["serious", "critical"].includes(v.impact ?? ""),
  );
  expect(serious, `${label}: ${JSON.stringify(serious, null, 2)}`).toEqual([]);
}

test.beforeEach(async () => {
  await resetDurableState();
  await resetE2eControls();
  await setDurationOverride(90);
});

test("accessibility: upload page", async ({ page }) => {
  const session = await createSession();
  await seedOwnerSession(page, session.token);
  await openUpload(page);
  await expectNoSeriousA11y(page, "upload");
});

test("accessibility: player confirmation", async ({ page }) => {
  const session = await createSession();
  await seedOwnerSession(page, session.token);
  await openUpload(page);
  await fillGameplayProfile(page);
  await uploadFixture(page, FIXTURES.shortMp4);
  await forceIdentityFixture(page, "low_confidence_multiple_players");
  await expect(page.getByRole("radiogroup", { name: /Candidate skaters/i })).toBeVisible({
    timeout: 30_000,
  });
  await expectNoSeriousA11y(page, "confirmation");
});

test("accessibility: analysis status + report", async ({ page }) => {
  await setSimulatorScenario("successful_short_clip");
  const session = await createSession();
  await seedOwnerSession(page, session.token);
  await prepareReadyToAnalyze(page);
  await submitAnalysis(page);
  await expect(page.getByTestId("analysis-status-label")).toBeVisible();
  await expectNoSeriousA11y(page, "status");
  await waitForReportReady(page);
  await openReport(page);
  await expectNoSeriousA11y(page, "report");
});

test("accessibility: failed and cancelled states", async ({ page }) => {
  await setSimulatorScenario("provider_failure_during_analysis");
  const session = await createSession();
  await seedOwnerSession(page, session.token);
  await prepareReadyToAnalyze(page);
  await submitAnalysis(page);
  await expect(page.getByTestId("analysis-failed-panel")).toBeVisible({ timeout: 60_000 });
  await expectNoSeriousA11y(page, "failed");

  await resetDurableState();
  await setSimulatorScenario("cancel_during_analysis");
  await prepareReadyToAnalyze(page);
  await submitAnalysis(page);
  await expect(page.getByTestId("cancel-analysis")).toBeVisible({ timeout: 20_000 });
  await page.getByTestId("cancel-analysis").click();
  await waitForStatus(page, /cancel/i, 45_000);
  await expectNoSeriousA11y(page, "cancelled");
});

test("keyboard confirmation journey to report", async ({ page }) => {
  await setSimulatorScenario("successful_short_clip");
  const session = await createSession();
  await seedOwnerSession(page, session.token);
  await openUpload(page);
  await fillGameplayProfile(page);
  await uploadFixture(page, FIXTURES.shortMp4);
  await forceIdentityFixture(page, "low_confidence_multiple_players");
  await expect(page.getByRole("radiogroup", { name: /Candidate skaters/i })).toBeVisible({
    timeout: 30_000,
  });
  await page.getByRole("radio").first().focus();
  await page.keyboard.press("Space");
  await page.getByRole("button", { name: /Confirm my player/i }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: /Analyze my gameplay/i })).toBeVisible();
  await page.getByRole("button", { name: /Analyze my gameplay/i }).focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/analysis\//);
  await waitForReportReady(page);
  await page.getByTestId("view-coaching-report").focus();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("report-header")).toBeVisible();
});
