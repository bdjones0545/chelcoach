import { expect, test } from "@playwright/test";
import {
  createSession,
  resetE2eControls,
  setDurationOverride,
  setSimulatorScenario,
} from "../helpers/api";
import {
  assertNoLeaks,
  assertReportCoreSections,
  attachNetworkGuards,
  confirmPlayerIfNeeded,
  fillGameplayProfile,
  openReport,
  openUpload,
  seedOwnerSession,
  submitAnalysis,
  uploadFixture,
  waitForReportReady,
} from "../helpers/browser";
import {
  assertNoSecretsInDb,
  countAnalysisJobs,
  countSimulatorJobs,
  getEventSequences,
  getJobByApplicationRequestId,
  resetDurableState,
} from "../helpers/db";
import { FIXTURES } from "../helpers/env";

test.beforeEach(async () => {
  await resetDurableState();
  await resetE2eControls();
  await setDurationOverride(90);
  await setSimulatorScenario(null);
});

test("golden path: upload → identify → analyze → refresh → report", async ({ page }) => {
  const session = await createSession();
  await seedOwnerSession(page, session.token);
  const net = attachNetworkGuards(page);

  await openUpload(page);
  await fillGameplayProfile(page);
  await uploadFixture(page, FIXTURES.shortMp4);
  await confirmPlayerIfNeeded(page);

  const applicationRequestId = await submitAnalysis(page);
  await expect(page.getByTestId("analysis-status-label")).toBeVisible();
  await expect(page.getByTestId("simulator-dev-label")).toBeVisible();

  await expect
    .poll(async () => page.getByTestId("analysis-status-label").textContent(), {
      timeout: 20_000,
    })
    .not.toMatch(/complete/i);

  await page.reload();
  await expect(page).toHaveURL(new RegExp(`/analysis/${applicationRequestId}$`));
  await expect(page.getByTestId("analysis-status-label")).toBeVisible();

  await waitForReportReady(page);
  await openReport(page);
  await assertReportCoreSections(page);
  await expect(page.getByTestId("report-header")).toContainText(/Scotty/);
  await assertNoLeaks(page);

  net.assertChelCoachOnly();
  net.assertNoLegacyUpload();

  const pollsBefore = net.statusPollCount();
  await page.waitForTimeout(1500);
  expect(net.statusPollCount()).toBe(pollsBefore);

  expect(await countAnalysisJobs()).toBe(1);
  expect(await countSimulatorJobs()).toBe(1);

  const row = await getJobByApplicationRequestId(applicationRequestId);
  expect(row?.canonical_status).toBe("completed");
  expect(row?.report_available).toBe(true);
  expect(row?.owner_id).toBe(session.ownerId);

  const seqs = await getEventSequences(applicationRequestId);
  for (let i = 1; i < seqs.length; i++) {
    expect(seqs[i]!).toBeGreaterThanOrEqual(seqs[i - 1]!);
  }
  await assertNoSecretsInDb(applicationRequestId);
});

test("rapid double-click analysis submission reuses one job", async ({ page }) => {
  const session = await createSession();
  await seedOwnerSession(page, session.token);
  await openUpload(page);
  await fillGameplayProfile(page);
  await uploadFixture(page, FIXTURES.shortMp4);
  const { forceIdentityFixture } = await import("../helpers/browser");
  await forceIdentityFixture(page, "high_confidence_center");
  await expect(page.getByRole("button", { name: /Analyze my gameplay/i })).toBeVisible({
    timeout: 30_000,
  });

  const analyze = page.getByRole("button", { name: /Analyze my gameplay/i });
  await Promise.all([analyze.click(), analyze.click().catch(() => undefined)]);
  await expect(page).toHaveURL(/\/analysis\/[^/]+$/, { timeout: 30_000 });
  expect(await countAnalysisJobs()).toBe(1);
  expect(await countSimulatorJobs()).toBe(1);
});

test("short clip classification produces bounded report with limitations", async ({ page }) => {
  await setDurationOverride(90);
  const session = await createSession();
  await seedOwnerSession(page, session.token);
  await openUpload(page);
  await fillGameplayProfile(page);
  await uploadFixture(page, FIXTURES.shortMp4);
  await confirmPlayerIfNeeded(page);
  await submitAnalysis(page);
  await waitForReportReady(page);
  await openReport(page);
  await expect(page.getByTestId("report-limitations")).toBeVisible();
  await assertReportCoreSections(page);
});

test("full-game classification produces broader report", async ({ page }) => {
  await setDurationOverride(1200);
  await setSimulatorScenario("successful_full_game");
  const session = await createSession();
  await seedOwnerSession(page, session.token);
  await openUpload(page);
  await fillGameplayProfile(page);
  await uploadFixture(page, FIXTURES.fullMp4);
  await confirmPlayerIfNeeded(page);
  await submitAnalysis(page);
  await waitForReportReady(page);
  await openReport(page);
  await assertReportCoreSections(page);
  await expect(page.getByTestId("report-strategy")).toBeVisible();
  await expect(page.getByTestId("report-faceoffs")).toBeVisible();
});
