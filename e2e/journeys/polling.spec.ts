import { expect, test } from "@playwright/test";
import {
  createSession,
  resetE2eControls,
  setDurationOverride,
  setSimulatorScenario,
} from "../helpers/api";
import {
  attachNetworkGuards,
  openReport,
  prepareReadyToAnalyze,
  seedOwnerSession,
  submitAnalysis,
  waitForReportReady,
  waitForStatus,
} from "../helpers/browser";
import { resetDurableState } from "../helpers/db";

test.beforeEach(async () => {
  await resetDurableState();
  await resetE2eControls();
  await setDurationOverride(90);
});

test("status polling stops on terminal and does not overlap aggressively", async ({ page }) => {
  await setSimulatorScenario("successful_short_clip");
  const session = await createSession();
  await seedOwnerSession(page, session.token);
  const net = attachNetworkGuards(page);
  await prepareReadyToAnalyze(page);
  await submitAnalysis(page);
  await waitForReportReady(page);

  const terminalPolls = net.statusPollCount();
  await page.waitForTimeout(2500);
  expect(net.statusPollCount()).toBe(terminalPolls);

  // Sanity: polls happened, but not an absurd burst for ~2s lifecycle.
  expect(terminalPolls).toBeGreaterThan(0);
  expect(terminalPolls).toBeLessThan(40);
});

test("status polling stops while awaiting provider confirmation", async ({ page }) => {
  await setSimulatorScenario("player_confirmation_required");
  const session = await createSession();
  await seedOwnerSession(page, session.token);
  const net = attachNetworkGuards(page);
  await prepareReadyToAnalyze(page);
  await submitAnalysis(page);
  await expect(page.getByTestId("provider-confirmation-panel")).toBeVisible({ timeout: 45_000 });
  const atConfirm = net.statusPollCount();
  await page.waitForTimeout(2500);
  expect(net.statusPollCount()).toBeLessThanOrEqual(atConfirm + 1);
});

test("report fetched once after navigation", async ({ page }) => {
  await setSimulatorScenario("successful_short_clip");
  const session = await createSession();
  await seedOwnerSession(page, session.token);
  const reportGets: string[] = [];
  page.on("request", (req) => {
    if (req.method() === "GET" && /\/api\/analysis\/[^/]+\/report$/.test(req.url())) {
      reportGets.push(req.url());
    }
  });
  await prepareReadyToAnalyze(page);
  await submitAnalysis(page);
  await waitForReportReady(page);
  await openReport(page);
  await page.waitForTimeout(1500);
  expect(reportGets.length).toBeGreaterThanOrEqual(1);
  expect(reportGets.length).toBeLessThanOrEqual(2);
  void waitForStatus;
});
