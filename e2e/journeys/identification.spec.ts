import { expect, test } from "@playwright/test";
import { createSession, resetE2eControls, setDurationOverride } from "../helpers/api";
import {
  fillGameplayProfile,
  forceIdentityFixture,
  openUpload,
  seedOwnerSession,
  submitAnalysis,
  uploadFixture,
} from "../helpers/browser";
import { countAnalysisJobs, resetDurableState } from "../helpers/db";
import { FIXTURES } from "../helpers/env";

test.beforeEach(async () => {
  await resetDurableState();
  await resetE2eControls();
  await setDurationOverride(90);
});

test("high-confidence identification allows analyze without mandatory selection", async ({
  page,
}) => {
  const session = await createSession();
  await seedOwnerSession(page, session.token);
  await openUpload(page);
  await fillGameplayProfile(page);
  await uploadFixture(page, FIXTURES.shortMp4);
  await forceIdentityFixture(page, "high_confidence_center");
  await expect(page.getByRole("button", { name: /Analyze my gameplay/i })).toBeVisible();
  await expect(page.getByRole("button", { name: /That is not my player/i })).toBeVisible();
  const id = await submitAnalysis(page);
  expect(id).toBeTruthy();
});

test("low-confidence confirmation is keyboard accessible and submits confirmed player", async ({
  page,
}) => {
  const session = await createSession();
  await seedOwnerSession(page, session.token);
  await openUpload(page);
  await fillGameplayProfile(page);
  await uploadFixture(page, FIXTURES.shortMp4);
  await forceIdentityFixture(page, "low_confidence_multiple_players");

  await expect(page.getByRole("radiogroup", { name: /Candidate skaters/i })).toBeVisible({
    timeout: 30_000,
  });
  const first = page.getByRole("radio").first();
  await first.focus();
  await page.keyboard.press("Space");
  await page.getByRole("button", { name: /Confirm my player/i }).click();
  await expect(page.getByRole("button", { name: /Analyze my gameplay/i })).toBeVisible();
  await submitAnalysis(page);
  expect(await countAnalysisJobs()).toBe(1);
});

test("player correction from high confidence requires selection", async ({ page }) => {
  const session = await createSession();
  await seedOwnerSession(page, session.token);
  await openUpload(page);
  await fillGameplayProfile(page);
  await uploadFixture(page, FIXTURES.shortMp4);
  await forceIdentityFixture(page, "high_confidence_center");
  await page.getByRole("button", { name: /That is not my player/i }).click();
  await expect(page.getByRole("radiogroup", { name: /Candidate skaters/i })).toBeVisible({
    timeout: 30_000,
  });
  await page.getByRole("radio").first().click();
  await page.getByRole("button", { name: /Confirm my player/i }).click();
  await expect(page.getByRole("button", { name: /Analyze my gameplay/i })).toBeVisible();
});

test("none-of-the-above can leave unresolved and blocks analysis", async ({ page }) => {
  const session = await createSession();
  await seedOwnerSession(page, session.token);
  await openUpload(page);
  await fillGameplayProfile(page);
  await uploadFixture(page, FIXTURES.shortMp4);
  await forceIdentityFixture(page, "candidate_none_correct");
  await expect(page.getByRole("button", { name: /None of these are my player/i })).toBeVisible({
    timeout: 30_000,
  });
  await page.getByRole("button", { name: /None of these are my player/i }).click();
  const leave = page.getByRole("button", { name: /Leave unresolved/i });
  const retry = page.getByRole("button", { name: /Try one more pass/i });
  await expect(leave.or(retry)).toBeVisible({ timeout: 20_000 });
  if (await retry.isVisible().catch(() => false)) {
    await retry.click();
    await page
      .getByRole("button", { name: /None of these are my player/i })
      .click({ timeout: 20_000 })
      .catch(() => undefined);
  }
  if (await leave.isVisible().catch(() => false)) {
    await leave.click();
  }
  await expect(page.getByRole("button", { name: /Analyze my gameplay/i })).toHaveCount(0);
  expect(await countAnalysisJobs()).toBe(0);
});

test("unresolved identity blocks analysis submission via API", async ({ page }) => {
  const session = await createSession();
  await seedOwnerSession(page, session.token);
  await openUpload(page);
  await fillGameplayProfile(page);
  await uploadFixture(page, FIXTURES.shortMp4);
  await forceIdentityFixture(page, "candidate_none_correct");
  await page.getByRole("button", { name: /None of these are my player/i }).click();
  const leave = page.getByRole("button", { name: /Leave unresolved/i });
  const retry = page.getByRole("button", { name: /Try one more pass/i });
  await expect(leave.or(retry)).toBeVisible({ timeout: 20_000 });
  if (await retry.isVisible().catch(() => false)) {
    await retry.click();
    await page
      .getByRole("button", { name: /None of these are my player/i })
      .click({ timeout: 20_000 })
      .catch(() => undefined);
  }
  if (await leave.isVisible().catch(() => false)) await leave.click();

  const uploadId = new URL(page.url()).searchParams.get("uploadId")!;
  const { API_BASE } = await import("../helpers/env");
  const res = await fetch(`${API_BASE}/api/uploads/${uploadId}/analysis`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${session.token}`,
      "content-type": "application/json",
    },
    body: "{}",
  });
  expect([404, 409, 422]).toContain(res.status);
  expect(await countAnalysisJobs()).toBe(0);
});
