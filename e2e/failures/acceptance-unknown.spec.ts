/**
 * Acceptance-unknown is covered primarily by server integration tests
 * (server/src/provider/jobs/jobs.test.ts — "marks acceptance unknown…").
 * This browser-adjacent API test verifies reconcile can examine durable jobs
 * after a successful simulator acceptance without duplicating work.
 */
import { expect, test } from "@playwright/test";
import {
  createSession,
  reconcile,
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
  await setSimulatorScenario("successful_short_clip");
});

test("reconcile after completion does not create duplicate provider jobs", async ({ page }) => {
  const session = await createSession();
  await seedOwnerSession(page, session.token);
  await prepareReadyToAnalyze(page);
  await submitAnalysis(page);
  await waitForReportReady(page);
  expect(await countAnalysisJobs()).toBe(1);
  expect(await countSimulatorJobs()).toBe(1);

  const result = await reconcile(
    25,
    process.env.CHELCOACH_RECONCILE_SECRET || "e2e-reconcile-secret",
  );
  expect(result.status).toBe(200);
  expect(await countAnalysisJobs()).toBe(1);
  expect(await countSimulatorJobs()).toBe(1);
});
