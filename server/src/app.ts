import cors from "cors";
import express from "express";
import type { NextFunction, Request, Response } from "express";
import { wirePersistence } from "./persistence";
import { configureDefaultFrameExtractor } from "./identification/extractor";
import { loadScottyProviderConfig, ProviderConfigError } from "./provider/config";
import { createScottyProvider, setScottyProviderForTests } from "./provider/factory";
import { analysisRouter } from "./routes/analysis";
import { clipsRouter } from "./routes/clips";
import { healthRouter } from "./routes/health";
import { playerIdentificationRouter } from "./routes/playerIdentification";
import { profileRouter } from "./routes/profile";
import { scottyUploadsRouter } from "./routes/scottyUploads";
import { sessionRouter } from "./routes/session";
import { uploadsRouter } from "./routes/uploads";

export function createApp() {
  // Prefer Drizzle when DATABASE_URL is present; otherwise in-memory repos (CI/local).
  wirePersistence();
  configureDefaultFrameExtractor();

  // Validate provider configuration at boot — never silently fall back.
  // Tests inject providers via setScottyProviderForTests; skip forced init there.
  if (process.env.NODE_ENV !== "test" && process.env.CHELCOACH_SKIP_PROVIDER_VALIDATION !== "1") {
    try {
      const cfg = loadScottyProviderConfig();
      setScottyProviderForTests(createScottyProvider(cfg));
    } catch (err) {
      if (err instanceof ProviderConfigError) {
        console.error(`[chelcoach-provider] ${err.message}`);
        throw err;
      }
      throw err;
    }
  }

  const app = express();

  // Lock CORS to the app origin(s). Comma-separated CORS_ORIGIN, or allow all in dev.
  const origin = process.env.CORS_ORIGIN?.split(",").map((s) => s.trim());
  app.use(cors(origin ? { origin } : undefined));
  app.use(express.json({ limit: "1mb" }));

  app.use("/api/health", healthRouter);
  app.use("/api", sessionRouter);
  app.use("/api", profileRouter);
  // Scotty Step 2 streamed uploads (must register before legacy buffered routes).
  app.use("/api", scottyUploadsRouter);
  // Scotty Step 3 controlled-player identification / confirmation.
  app.use("/api", playerIdentificationRouter);
  // Scotty Step 4 provider-independent analysis submission.
  app.use("/api", analysisRouter);
  // Legacy Phase-2 clip upload path (buffered) — demo/legacy only; capped separately.
  app.use("/api", uploadsRouter);
  app.use("/api", clipsRouter);

  // 404
  app.use((_req, res) => {
    res.status(404).json({ error: "not_found", message: "No such endpoint." });
  });

  // Central error handler
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    // Body over the configured limit (e.g. an oversized upload) → 413.
    if (err && typeof err === "object" && (err as { type?: string }).type === "entity.too.large") {
      res.status(413).json({ error: "oversized_file", message: "File exceeds the upload size limit." });
      return;
    }
    const message = err instanceof Error ? err.message : "Unexpected error.";
    console.error("[chelcoach-api] error:", message);
    res.status(500).json({ error: "internal_error", message });
  });

  return app;
}
