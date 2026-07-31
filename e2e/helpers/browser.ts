import path from "node:path";
import { expect, type Page, type Request } from "@playwright/test";
import { resetIdentification } from "./api";
import { FIXTURES, FORBIDDEN_LEAKS } from "./env";

export async function seedOwnerSession(page: Page, token: string): Promise<void> {
  await page.addInitScript((t) => {
    localStorage.setItem("chelcoach_owner_token", t);
  }, token);
}

export async function clearOwnerSession(page: Page): Promise<void> {
  await page.evaluate(() => localStorage.removeItem("chelcoach_owner_token"));
}

export async function openUpload(page: Page): Promise<void> {
  await page.goto("/upload");
  await expect(page.getByRole("heading", { name: "Upload Gameplay" })).toBeVisible({
    timeout: 20_000,
  });
}

export async function fillGameplayProfile(
  page: Page,
  opts?: {
    platformLabel?: string;
    schemeLabel?: string;
    positionLabel?: string;
    modeLabel?: string;
  },
): Promise<void> {
  const selects = page.locator("select");
  await selects.nth(0).selectOption({ index: 1 }).catch(async () => {
    await selects.nth(0).selectOption({ label: /NHL/i });
  });
  await selects.nth(1).selectOption({ label: opts?.platformLabel ?? "Xbox Series X|S" });
  await selects.nth(2).selectOption({ label: opts?.schemeLabel ?? "Skill Stick" });
  await selects.nth(3).selectOption({ label: opts?.positionLabel ?? "Center" });
  await selects.nth(4).selectOption({ label: opts?.modeLabel ?? "EASHL" });
  await page.getByLabel(/I control one player/i).check();
}

export async function uploadFixture(
  page: Page,
  fixtureRelPath: string = FIXTURES.shortMp4,
): Promise<void> {
  const filePath = path.resolve(fixtureRelPath);
  await page.locator('input[aria-label="Choose a game clip to upload"]').setInputFiles(filePath);
  await page.getByRole("button", { name: /Get My Chel Rating/i }).click();
  await expect(page).toHaveURL(/player-confirmation/, { timeout: 60_000 });
}

export async function uploadExpectingFailure(
  page: Page,
  fixtureRelPath: string,
): Promise<void> {
  const filePath = path.resolve(fixtureRelPath);
  await page.locator('input[aria-label="Choose a game clip to upload"]').setInputFiles(filePath);
  await page.getByRole("button", { name: /Get My Chel Rating/i }).click();
  await expect(page).not.toHaveURL(/player-confirmation/, { timeout: 15_000 });
}

export async function forceIdentityFixture(page: Page, fixture: string): Promise<void> {
  const uploadId = new URL(page.url()).searchParams.get("uploadId");
  if (!uploadId) throw new Error("missing uploadId on player-confirmation URL");
  // Wait for the default auto-start identification to settle so an in-flight write
  // cannot recreate the old fixture after we clear it.
  await expect(
    page
      .getByRole("button", { name: /Analyze my gameplay|Confirm my player|None of these are my player/i })
      .or(page.getByRole("radiogroup", { name: /Candidate skaters/i }))
      .first(),
  ).toBeVisible({ timeout: 30_000 });
  await resetIdentification(uploadId);
  await page.goto(
    `/player-confirmation?uploadId=${encodeURIComponent(uploadId)}&fixture=${fixture}`,
  );
  await expect(
    page
      .getByRole("button", { name: /Analyze my gameplay|Confirm my player|None of these are my player|That is not my player/i })
      .first(),
  ).toBeVisible({ timeout: 30_000 });
}

export async function confirmPlayerIfNeeded(page: Page): Promise<void> {
  const analyze = page.getByRole("button", { name: /Analyze my gameplay/i });
  const confirm = page.getByRole("button", { name: /Confirm my player/i });
  await expect(analyze.or(confirm)).toBeVisible({ timeout: 30_000 });
  if (await confirm.isVisible().catch(() => false)) {
    const radios = page.getByRole("radio");
    if ((await radios.count()) > 0) {
      await radios.first().click();
    }
    await confirm.click();
    await expect(analyze).toBeVisible({ timeout: 20_000 });
  }
}

export async function submitAnalysis(page: Page): Promise<string> {
  await page.getByRole("button", { name: /Analyze my gameplay/i }).click();
  await expect(page).toHaveURL(/\/analysis\/[^/]+$/, { timeout: 30_000 });
  const url = page.url();
  const match = url.match(/\/analysis\/([^/?#]+)/);
  if (!match?.[1]) throw new Error(`missing applicationRequestId in ${url}`);
  return decodeURIComponent(match[1]);
}

export async function waitForReportReady(page: Page): Promise<void> {
  await expect(page.getByTestId("view-coaching-report")).toBeVisible({ timeout: 90_000 });
}

export async function waitForStatus(
  page: Page,
  pattern: RegExp,
  timeout = 60_000,
): Promise<void> {
  await expect
    .poll(async () => page.getByTestId("analysis-status-label").textContent(), { timeout })
    .toMatch(pattern);
}

export async function openReport(page: Page): Promise<void> {
  await page.getByTestId("view-coaching-report").click();
  await expect(page).toHaveURL(/\/report$/);
  await expect(page.getByTestId("report-header")).toBeVisible({ timeout: 30_000 });
}

export async function assertReportCoreSections(page: Page): Promise<void> {
  await expect(page.getByTestId("report-header")).toBeVisible();
  await expect(page.getByTestId("report-executive-summary")).toBeVisible();
  await expect(page.getByTestId("report-strengths")).toBeVisible();
  await expect(page.getByTestId("report-improvements")).toBeVisible();
  await expect(page.getByTestId("report-gameplay-moments")).toBeVisible();
  await expect(page.getByTestId("report-controls")).toBeVisible();
  await expect(page.getByTestId("report-practice-plan")).toBeVisible();
  await expect(page.getByTestId("report-next-game-focus")).toBeVisible();
}

export async function assertNoLeaks(page: Page): Promise<void> {
  const html = await page.content();
  for (const leak of FORBIDDEN_LEAKS) {
    expect(html, `page leaked ${leak}`).not.toContain(leak);
  }
}

export function attachNetworkGuards(page: Page): {
  requests: Request[];
  assertChelCoachOnly: () => void;
  assertNoLegacyUpload: () => void;
  statusPollCount: () => number;
  statusPollUrls: () => string[];
} {
  const requests: Request[] = [];
  page.on("request", (req) => requests.push(req));

  return {
    requests,
    assertChelCoachOnly: () => {
      for (const req of requests) {
        const url = req.url();
        expect(url, "must not call Anthropic").not.toMatch(/anthropic\.com/i);
        expect(url, "must not call OpenAI").not.toMatch(/openai\.com/i);
        expect(url, "must not call Cloudflare tunnel").not.toMatch(
          /trycloudflare\.com|cloudflare/i,
        );
        expect(url, "must not call Scotty VM directly").not.toMatch(/\/v1\/analysis\/jobs/i);
      }
    },
    assertNoLegacyUpload: () => {
      const legacy = requests.filter((r) => /\/api\/clips\/[^/]+\/file/.test(r.url()));
      expect(legacy, "UI must not call legacy PUT /api/clips/:id/file").toHaveLength(0);
      const streamed = requests.filter(
        (r) => r.method() === "PUT" && /\/api\/uploads\/[^/]+\/content/.test(r.url()),
      );
      expect(streamed.length).toBeGreaterThan(0);
    },
    statusPollCount: () =>
      requests.filter((r) => r.method() === "GET" && /\/api\/analysis\/[^/]+$/.test(r.url()))
        .length,
    statusPollUrls: () =>
      requests
        .filter((r) => r.method() === "GET" && /\/api\/analysis\/[^/]+$/.test(r.url()))
        .map((r) => r.url()),
  };
}

export async function prepareReadyToAnalyze(
  page: Page,
  opts?: {
    fixture?: string;
    identityFixture?: string;
    platformLabel?: string;
    schemeLabel?: string;
  },
): Promise<void> {
  await openUpload(page);
  await fillGameplayProfile(page, {
    platformLabel: opts?.platformLabel,
    schemeLabel: opts?.schemeLabel,
  });
  await uploadFixture(page, opts?.fixture ?? FIXTURES.shortMp4);
  if (opts?.identityFixture) {
    await forceIdentityFixture(page, opts.identityFixture);
  } else {
    await forceIdentityFixture(page, "high_confidence_center");
  }
  await confirmPlayerIfNeeded(page);
  await expect(page.getByRole("button", { name: /Analyze my gameplay/i })).toBeVisible();
}

export async function goldenPathToReport(
  page: Page,
  opts?: { fixture?: string; identityFixture?: string },
): Promise<string> {
  await prepareReadyToAnalyze(page, opts);
  const applicationRequestId = await submitAnalysis(page);
  await expect(page.getByTestId("analysis-status-label")).toBeVisible();
  await waitForReportReady(page);
  await openReport(page);
  await assertNoLeaks(page);
  return applicationRequestId;
}
