import { expect, type Page, type Response } from "@playwright/test";
import { FORBIDDEN_LEAKS } from "./env";

export async function assertJsonNoLeaks(res: Response): Promise<void> {
  const text = await res.text();
  for (const leak of FORBIDDEN_LEAKS) {
    expect(text, `response leaked ${leak}`).not.toContain(leak);
  }
  // Avoid stack-looking payloads
  expect(text).not.toMatch(/at\s+\w+\s+\(.*:\d+:\d+\)/);
}

export async function assertPageNoLeaks(page: Page): Promise<void> {
  const html = await page.content();
  for (const leak of FORBIDDEN_LEAKS) {
    expect(html).not.toContain(leak);
  }
}
