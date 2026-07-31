import { expect, test } from "@playwright/test";
import { createSession, resetE2eControls, setDurationOverride } from "../helpers/api";
import {
  forceIdentityFixture,
  fillGameplayProfile,
  openReport,
  openUpload,
  prepareReadyToAnalyze,
  seedOwnerSession,
  submitAnalysis,
  uploadFixture,
  waitForReportReady,
} from "../helpers/browser";
import { resetDurableState } from "../helpers/db";
import { FIXTURES } from "../helpers/env";

async function assertNoHorizontalOverflow(page: import("@playwright/test").Page) {
  const overflow = await page.evaluate(() => {
    const doc = document.documentElement;
    return doc.scrollWidth > doc.clientWidth + 1;
  });
  expect(overflow, "horizontal overflow").toBe(false);
}

test.beforeEach(async () => {
  await resetDurableState();
  await resetE2eControls();
  await setDurationOverride(90);
});

test("mobile upload + confirmation usable", async ({ page }) => {
  const session = await createSession();
  await seedOwnerSession(page, session.token);
  await openUpload(page);
  await fillGameplayProfile(page);
  await assertNoHorizontalOverflow(page);
  await uploadFixture(page, FIXTURES.shortMp4);
  await forceIdentityFixture(page, "low_confidence_multiple_players");
  await expect(page.getByRole("radiogroup", { name: /Candidate skaters/i })).toBeVisible({
    timeout: 30_000,
  });
  await assertNoHorizontalOverflow(page);
  await expect(page.getByRole("button", { name: /Confirm my player/i })).toBeVisible();
});

test("mobile status + report usable", async ({ page }) => {
  const session = await createSession();
  await seedOwnerSession(page, session.token);
  await prepareReadyToAnalyze(page);
  await submitAnalysis(page);
  await expect(page.getByTestId("analysis-status-label")).toBeVisible();
  await assertNoHorizontalOverflow(page);
  await waitForReportReady(page);
  await openReport(page);
  await assertNoHorizontalOverflow(page);
  await expect(page.getByTestId("report-gameplay-moments")).toBeVisible();
  await expect(page.getByTestId("report-controls")).toBeVisible();
  await expect(page.getByTestId("report-practice-plan")).toBeVisible();
});

test("tablet viewport report stacks without overflow", async ({ page }) => {
  await page.setViewportSize({ width: 768, height: 1024 });
  const session = await createSession();
  await seedOwnerSession(page, session.token);
  await prepareReadyToAnalyze(page);
  await submitAnalysis(page);
  await waitForReportReady(page);
  await openReport(page);
  await assertNoHorizontalOverflow(page);
});
