import { defineConfig, devices } from "@playwright/test";

const FRONTEND_PORT = Number(process.env.E2E_FRONTEND_PORT || 5173);
const API_PORT = Number(process.env.E2E_API_PORT || 3001);
const FRONTEND_URL = `http://127.0.0.1:${FRONTEND_PORT}`;
const API_URL = `http://127.0.0.1:${API_PORT}`;

const e2eEnv = {
  ...process.env,
  NODE_ENV: "development",
  CHELCOACH_E2E_MODE: "1",
  CHELCOACH_E2E_SECRET: process.env.CHELCOACH_E2E_SECRET || "e2e-secret",
  CHELCOACH_E2E_FAKE_MEDIA_DURATION_SEC: "90",
  CHELCOACH_ANALYSIS_PROVIDER: "simulator",
  CHELCOACH_SCOTTY_SIMULATOR_ENABLED: "true",
  CHELCOACH_SCOTTY_SIMULATOR_ALLOW_IN_PRODUCTION: "false",
  CHELCOACH_USE_FFMPEG_FRAMES: "false",
  CHELCOACH_ALLOW_IDENTITY_FIXTURES: "1",
  CHELCOACH_RAW_MEDIA_RETENTION_HOURS: "24",
  CHELCOACH_PENDING_UPLOAD_EXPIRATION_HOURS: "2",
  CHELCOACH_RECONCILE_SECRET: process.env.CHELCOACH_RECONCILE_SECRET || "e2e-reconcile-secret",
  CHELCOACH_CLEANUP_SECRET: process.env.CHELCOACH_CLEANUP_SECRET || "e2e-cleanup-secret-distinct",
  CHELCOACH_AUTH_MODE: "development_session",
  CHELCOACH_PRODUCTION_AUTH_READY: "false",
  CHELCOACH_SCOTTY_CALLBACKS_ENABLED: "0",
  CHELCOACH_LEGACY_UPLOAD_ENABLED: "true",
  SCOTTY_SIMULATOR_DEFAULT_SCENARIO: "auto",
  SCOTTY_SIMULATOR_QUEUED_MS: "150",
  SCOTTY_SIMULATOR_INSPECTING_MS: "200",
  SCOTTY_SIMULATOR_EXTRACTING_MS: "200",
  SCOTTY_SIMULATOR_IDENTIFYING_MS: "200",
  SCOTTY_SIMULATOR_ANALYZING_MS: "500",
  SCOTTY_SIMULATOR_VALIDATING_MS: "200",
  SCOTTY_SIMULATOR_FINALIZING_MS: "150",
  SCOTTY_SIMULATOR_POLL_MS: "200",
  PORT: String(API_PORT),
  CORS_ORIGIN: FRONTEND_URL,
  // Durable Postgres when DATABASE_URL is provided; do not force memory.
  CHELCOACH_FORCE_MEMORY_REPOS: process.env.CHELCOACH_FORCE_MEMORY_REPOS || "",
  DATABASE_URL:
    process.env.DATABASE_URL ||
    "postgresql://chelcoach:chelcoach@127.0.0.1:5432/chelcoach_test",
};

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  timeout: 120_000,
  expect: { timeout: 20_000 },
  reporter: [["list"], ["html", { open: "never", outputFolder: "playwright-report" }]],
  outputDir: "test-results",
  use: {
    baseURL: FRONTEND_URL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "firefox-smoke",
      testMatch: /golden-path\.spec\.ts/,
      use: { ...devices["Desktop Firefox"] },
    },
    {
      name: "webkit-smoke",
      testMatch: /golden-path\.spec\.ts/,
      use: { ...devices["Desktop Safari"] },
    },
    {
      name: "mobile-chromium",
      testMatch: /(golden-path|mobile)\.spec\.ts/,
      use: { ...devices["Pixel 7"] },
    },
  ],
  webServer: [
    {
      command: "npm run start",
      cwd: "./server",
      url: `${API_URL}/api/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      env: e2eEnv,
    },
    {
      command: `npm run dev -- --host 127.0.0.1 --port ${FRONTEND_PORT}`,
      url: FRONTEND_URL,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      env: {
        ...process.env,
        VITE_USE_BACKEND_REPORTS: "true",
        VITE_API_BASE_URL: API_URL,
        VITE_ALLOW_IDENTITY_FIXTURES: "true",
      },
    },
  ],
});
