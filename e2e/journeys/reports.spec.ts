import { expect, test } from "@playwright/test";
import {
  createSession,
  resetE2eControls,
  runE2eCleanup,
  setDurationOverride,
  setSimulatorScenario,
} from "../helpers/api";
import {
  assertNoLeaks,
  assertReportCoreSections,
  attachNetworkGuards,
  openReport,
  prepareReadyToAnalyze,
  seedOwnerSession,
  submitAnalysis,
  waitForReportReady,
} from "../helpers/browser";
import {
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

test("Xbox controls isolated from PlayStation labels", async ({ page }) => {
  const session = await createSession();
  await seedOwnerSession(page, session.token);
  await prepareReadyToAnalyze(page, {
    platformLabel: "Xbox Series X|S",
    schemeLabel: "Skill Stick",
  });
  await submitAnalysis(page);
  await waitForReportReady(page);
  await openReport(page);
  const controls = page.getByTestId("report-controls");
  await expect(controls).toBeVisible();
  const text = (await controls.textContent()) ?? "";
  expect(text).not.toMatch(/\b(Cross|Circle|Square|Triangle|R2|L2)\b/);
});

test("PlayStation controls isolated from Xbox labels", async ({ page }) => {
  const session = await createSession();
  await seedOwnerSession(page, session.token);
  await prepareReadyToAnalyze(page, {
    platformLabel: "PlayStation 5",
    schemeLabel: "Skill Stick",
  });
  await submitAnalysis(page);
  await waitForReportReady(page);
  await openReport(page);
  const controls = page.getByTestId("report-controls");
  const text = (await controls.textContent()) ?? "";
  expect(text).not.toMatch(/\b(RT|LT|RB|LB|A button|X button)\b/i);
});

test("report survives source-media deletion", async ({ page }) => {
  const session = await createSession();
  await seedOwnerSession(page, session.token);
  await prepareReadyToAnalyze(page);
  const applicationRequestId = await submitAnalysis(page);
  await waitForReportReady(page);
  const job = await getJobByApplicationRequestId(applicationRequestId);
  expect(job?.upload_id).toBeTruthy();
  const cleanup = await runE2eCleanup(job!.upload_id);
  expect(cleanup.deleted).toBe(1);
  const upload = await getUploadRow(job!.upload_id);
  expect(upload?.upload_status).toBe("deleted");

  await page.goto(`/analysis/${applicationRequestId}/report`);
  await expect(page.getByTestId("report-header")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("source-media-notice")).toBeVisible();
  await assertReportCoreSections(page);
  await expect(page.getByTestId("report-practice-plan")).toBeVisible();
  await assertNoLeaks(page);
  await expect(page.locator("video")).toHaveCount(0);
});

test("report page does not poll status", async ({ page }) => {
  const session = await createSession();
  await seedOwnerSession(page, session.token);
  const net = attachNetworkGuards(page);
  await prepareReadyToAnalyze(page);
  const applicationRequestId = await submitAnalysis(page);
  await waitForReportReady(page);
  await page.goto(`/analysis/${applicationRequestId}/report`);
  await expect(page.getByTestId("report-header")).toBeVisible();
  const before = net.statusPollCount();
  await page.waitForTimeout(2000);
  expect(net.statusPollCount()).toBe(before);
});

test("print view retains core coaching sections", async ({ page }) => {
  const session = await createSession();
  await seedOwnerSession(page, session.token);
  await prepareReadyToAnalyze(page);
  await submitAnalysis(page);
  await waitForReportReady(page);
  await openReport(page);
  await page.emulateMedia({ media: "print" });
  // Print CSS may mark interactive chrome hidden; assert core content remains in the DOM.
  for (const testId of [
    "report-header",
    "report-executive-summary",
    "report-strengths",
    "report-improvements",
    "report-practice-plan",
    "report-next-game-focus",
  ]) {
    await expect(page.getByTestId(testId)).toBeAttached();
    await expect(page.getByTestId(testId)).not.toBeEmpty();
  }
  await assertNoLeaks(page);
});

test("full-game faceoff totals are consistent when present", async ({ page }) => {
  await setDurationOverride(1200);
  await setSimulatorScenario("successful_full_game");
  const session = await createSession();
  await seedOwnerSession(page, session.token);
  await prepareReadyToAnalyze(page, { fixture: "e2e/fixtures/full-game-metadata-fixture.mp4" });
  await submitAnalysis(page);
  await waitForReportReady(page);
  await openReport(page);
  const faceoffs = page.getByTestId("report-faceoffs");
  const omitted = page.getByTestId("report-faceoffs-omitted");
  if (await faceoffs.isVisible().catch(() => false)) {
    const text = (await faceoffs.textContent()) ?? "";
    expect(text).toMatch(/%/);
    expect(text).not.toMatch(/NaN/);
  } else {
    await expect(omitted).toBeVisible();
  }
});
