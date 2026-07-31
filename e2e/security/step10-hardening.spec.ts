import { expect, test } from "@playwright/test";
import { API_BASE, E2E_SECRET } from "../helpers/env";
import { createSession, resetE2eControls } from "../helpers/api";
import { attachNetworkGuards, seedOwnerSession } from "../helpers/browser";
import { resetDurableState } from "../helpers/db";

test.beforeEach(async () => {
  await resetDurableState();
  await resetE2eControls();
});

test("internal cleanup requires distinct secret; browser cannot call it", async ({ page }) => {
  const session = await createSession();
  await seedOwnerSession(page, session.token);
  const net = attachNetworkGuards(page);

  const missing = await fetch(`${API_BASE}/api/internal/media/cleanup`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  expect(missing.status).toBe(404);

  const wrong = await fetch(`${API_BASE}/api/internal/media/cleanup`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-chelcoach-cleanup-secret": "wrong",
    },
    body: "{}",
  });
  expect(wrong.status).toBe(404);

  // Reconcile secret must not unlock cleanup.
  const reused = await fetch(`${API_BASE}/api/internal/media/cleanup`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-chelcoach-cleanup-secret":
        process.env.CHELCOACH_RECONCILE_SECRET || "e2e-reconcile-secret",
    },
    body: "{}",
  });
  expect(reused.status).toBe(404);

  const ok = await fetch(`${API_BASE}/api/internal/media/cleanup`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-chelcoach-cleanup-secret":
        process.env.CHELCOACH_CLEANUP_SECRET || "e2e-cleanup-secret-distinct",
    },
    body: JSON.stringify({ limit: 5 }),
  });
  expect(ok.status).toBe(200);

  await page.goto("/");
  net.assertChelCoachOnly();
});

test("CSRF rejects hostile Origin on analysis submission", async () => {
  const session = await createSession();
  const res = await fetch(`${API_BASE}/api/uploads/00000000-0000-0000-0000-000000000001/analysis`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${session.token}`,
      origin: "https://evil.example",
    },
    body: "{}",
  });
  expect(res.status).toBe(403);
  const body = (await res.json()) as { error: string };
  // CORS middleware may reject before CSRF — both are valid production protections.
  expect(["CSRF_REJECTED", "CORS_REJECTED"]).toContain(body.error);
});

test("API security headers and private cache on authenticated status", async () => {
  const session = await createSession();
  const res = await fetch(`${API_BASE}/api/gameplay-profile`, {
    headers: {
      authorization: `Bearer ${session.token}`,
      "X-ChelCoach-Requested-With": "chelcoach",
    },
  });
  expect(res.status).toBe(200);
  expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  expect(res.headers.get("x-frame-options")).toBe("DENY");
  expect(res.headers.get("cache-control") ?? "").toMatch(/no-store/);
  expect(res.headers.get("content-security-policy") ?? "").toMatch(/default-src 'none'/);
  expect(res.headers.get("content-security-policy") ?? "").not.toMatch(/scotty/i);
});

test("E2E hooks absent without secret; ownerId in body is ignored", async () => {
  const noSecret = await fetch(`${API_BASE}/api/internal/e2e/reset-controls`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  expect(noSecret.status).toBe(404);

  const withSecret = await fetch(`${API_BASE}/api/internal/e2e/reset-controls`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-chelcoach-e2e-secret": E2E_SECRET,
    },
    body: "{}",
  });
  expect(withSecret.status).toBe(200);

  const session = await createSession();
  const forged = await fetch(`${API_BASE}/api/uploads`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${session.token}`,
      "X-ChelCoach-Requested-With": "chelcoach",
      origin: process.env.CORS_ORIGIN || "http://127.0.0.1:5173",
    },
    body: JSON.stringify({
      ownerId: "own_forged_other_user",
      filename: "clip.mp4",
      contentType: "video/mp4",
      sizeBytes: 4096,
      context: {
        gameContext: {
          selectedGameTitle: "NHL 25",
          canonicalGameId: "nhl-25",
          supportStatus: "supported",
          mismatchState: "none",
        },
        playerContext: {
          platform: "xbox_series",
          controlScheme: "skill_stick",
          position: "C",
          gameMode: "eashl",
        },
        singlePlayerControl: true,
      },
      saveAsDefaults: false,
    }),
  });
  // Either accepted with server owner or validation error — never creates forged owner.
  if (forged.status === 201) {
    const body = (await forged.json()) as { uploadId: string };
    const detail = await fetch(`${API_BASE}/api/uploads/${body.uploadId}`, {
      headers: { authorization: `Bearer ${session.token}` },
    });
    expect(detail.status).toBe(200);
  } else {
    expect([400, 422]).toContain(forged.status);
  }
});

test("readiness diagnostics do not expose secrets", async () => {
  const session = await createSession();
  const res = await fetch(`${API_BASE}/api/admin/readiness`, {
    headers: {
      authorization: `Bearer ${session.token}`,
      "X-ChelCoach-Requested-With": "chelcoach",
    },
  });
  expect(res.status).toBe(200);
  const text = await res.text();
  expect(text).not.toMatch(/e2e-reconcile-secret|e2e-cleanup-secret|SCOTTY_SIGNING|password=/i);
  expect(text).toMatch(/analysisSubmission/);
});
