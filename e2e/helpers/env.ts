export const API_BASE =
  process.env.VITE_API_BASE_URL ||
  `http://127.0.0.1:${process.env.E2E_API_PORT || 3001}`;

export const E2E_SECRET = process.env.CHELCOACH_E2E_SECRET || "e2e-secret";

export const FIXTURES = {
  shortMp4: "e2e/fixtures/short-valid-gameplay.mp4",
  extendedMp4: "e2e/fixtures/extended-valid-gameplay.mp4",
  fullMp4: "e2e/fixtures/full-game-metadata-fixture.mp4",
  invalidBin: "e2e/fixtures/invalid-media.bin",
  oversized: "e2e/fixtures/oversized-stream-fixture.mp4",
} as const;

export const FORBIDDEN_LEAKS = [
  "SCOTTY_BASE_URL",
  "SCOTTY_SIGNING_SECRET",
  "storageObjectKey",
  "requestFingerprint",
  "idempotencyKey",
  "DATABASE_URL",
  "postgresql://",
  "Bearer sk-",
] as const;
