import { expect, test } from "@playwright/test";

/**
 * Auth UI smoke (Step 10.1B).
 * Full live Supabase signup is covered by `npm run verify:supabase-auth` with
 * CHELCOACH_LIVE_AUTH_VERIFY=1 — CI keeps development_session and empty Vite Supabase.
 */
test.describe("Supabase Auth UI scaffolding", () => {
  test("login and signup routes are public", async ({ page }) => {
    await page.goto("/login");
    await expect(page.getByRole("heading", { name: /sign in/i })).toBeVisible();
    await page.goto("/signup");
    await expect(page.getByRole("heading", { name: /create account|sign up/i })).toBeVisible();
  });

  test("forgot-password route is public", async ({ page }) => {
    await page.goto("/forgot-password");
    await expect(page.locator("body")).toContainText(/password reset|supabase auth/i);
  });
});
