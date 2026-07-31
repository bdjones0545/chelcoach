import { expect, test } from "@playwright/test";
import {
  createSession,
  resetE2eControls,
  setDurationOverride,
  setSimulatorScenario,
} from "../helpers/api";
import {
  assertNoLeaks,
  prepareReadyToAnalyze,
  seedOwnerSession,
  submitAnalysis,
  waitForStatus,
} from "../helpers/browser";
import { getJobByApplicationRequestId, resetDurableState } from "../helpers/db";

const FAILURES: Array<{ scenario: string; errorHint: RegExp }> = [
  { scenario: "provider_failure_during_inspection", errorHint: /inspect|media|failed/i },
  { scenario: "provider_failure_during_analysis", errorHint: /analy|failed/i },
  { scenario: "report_validation_failure", errorHint: /validat|report|failed/i },
  { scenario: "provider_timeout", errorHint: /timeout|timed|failed/i },
];

test.beforeEach(async () => {
  await resetDurableState();
  await resetE2eControls();
  await setDurationOverride(90);
});

for (const { scenario, errorHint } of FAILURES) {
  test(`failure journey: ${scenario}`, async ({ page }) => {
    await setSimulatorScenario(scenario);
    const session = await createSession();
    await seedOwnerSession(page, session.token);
    await prepareReadyToAnalyze(page);
    const applicationRequestId = await submitAnalysis(page);

    await expect(page.getByTestId("analysis-failed-panel")).toBeVisible({ timeout: 60_000 });
    await waitForStatus(page, /fail|timeout|error/i, 10_000);
    await expect(page.getByTestId("view-coaching-report")).toHaveCount(0);
    await assertNoLeaks(page);

    const html = await page.content();
    expect(html).not.toMatch(/at\s+\w+\s+\(.*:\d+:\d+\)/);
    expect(html.toLowerCase()).toMatch(errorHint);

    await page.reload();
    await expect(page.getByTestId("analysis-failed-panel")).toBeVisible({ timeout: 20_000 });
    expect(await countJobsTerminal(applicationRequestId)).toBeTruthy();
  });
}

async function countJobsTerminal(applicationRequestId: string): Promise<boolean> {
  const row = await getJobByApplicationRequestId(applicationRequestId);
  return Boolean(row && ["failed", "cancelled"].includes(row.canonical_status));
}
