import cors from "cors";
import express from "express";
import type { NextFunction, Request, Response } from "express";
import { wirePersistence } from "./persistence";
import { configureDefaultFrameExtractor } from "./identification/extractor";
import {
  assertE2eNotEnabledInProduction,
  createE2eRouter,
  installE2eMediaInspector,
  isE2eMode,
} from "./e2e/hooks";
import {
  assertBootConfig,
  ChelCoachConfigError,
  getChelCoachConfig,
  resetChelCoachConfigCacheForTests,
} from "./config/chelcoachConfig";
import { loadScottyProviderConfig, ProviderConfigError } from "./provider/config";
import { createScottyProvider, setScottyProviderForTests } from "./provider/factory";
import { analysisRouter } from "./routes/analysis";
import { clipsRouter } from "./routes/clips";
import { healthRouter } from "./routes/health";
import { internalMediaRouter } from "./routes/internalMedia";
import { playerIdentificationRouter } from "./routes/playerIdentification";
import { profileRouter } from "./routes/profile";
import { readinessRouter } from "./routes/readiness";
import { scottyUploadsRouter } from "./routes/scottyUploads";
import { sessionRouter } from "./routes/session";
import { uploadsRouter } from "./routes/uploads";
import { csrfProtection } from "./security/csrf";
import { securityHeadersMiddleware } from "./security/headers";
import { publicErrorMessage } from "./security/logging";

export function createApp() {
  // Fail-closed boot validation (skipped only when explicitly opted out for unit tests).
  if (process.env.CHELCOACH_SKIP_CONFIG_VALIDATION !== "1") {
    try {
      assertBootConfig();
    } catch (err) {
      if (err instanceof ChelCoachConfigError) {
        console.error(`[chelcoach-config] ${err.message}`);
        if (process.env.NODE_ENV === "production") throw err;
        // Non-production: log and continue with loaded config when possible.
        resetChelCoachConfigCacheForTests();
        try {
          getChelCoachConfig();
        } catch {
          throw err;
        }
      } else {
        throw err;
      }
    }
  }

  assertE2eNotEnabledInProduction();

  // Prefer Drizzle when DATABASE_URL is present; otherwise in-memory repos (CI/local).
  wirePersistence();
  configureDefaultFrameExtractor();
  if (isE2eMode()) {
    installE2eMediaInspector();
  }

  // Validate provider configuration at boot — never silently fall back.
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
  const config = getChelCoachConfig();

  app.use(securityHeadersMiddleware);

  // Lock CORS — production requires explicit origins (validated at boot).
  // Internal routes are not browser-CORS enabled (no Access-Control allow for them).
  if (config.cors.allowedOrigins.length > 0) {
    app.use(
      cors({
        origin(origin, cb) {
          // Non-browser / same-origin tools may omit Origin.
          if (!origin) {
            cb(null, true);
            return;
          }
          if (config.cors.allowedOrigins.includes(origin)) {
            cb(null, true);
            return;
          }
          cb(new Error("CORS_ORIGIN_DENIED"));
        },
        credentials: config.cors.credentials,
        methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
        allowedHeaders: [
          "Content-Type",
          "Authorization",
          "X-ChelCoach-Owner-Token",
          "X-ChelCoach-Requested-With",
          "X-ChelCoach-E2E-Secret",
        ],
        maxAge: 600,
      }),
    );
  } else if (!config.isProduction) {
    app.use(cors());
  }

  // Separate JSON limits — do not use a large global limit for video (streamed separately).
  app.use(express.json({ limit: "256kb" }));
  app.use(csrfProtection);

  app.use("/api/health", healthRouter);
  app.use("/api", readinessRouter);
  app.use("/api", sessionRouter);
  app.use("/api", profileRouter);
  // Scotty Step 2 streamed uploads (must register before legacy buffered routes).
  app.use("/api", scottyUploadsRouter);
  // Scotty Step 3 controlled-player identification / confirmation.
  app.use("/api", playerIdentificationRouter);
  // Scotty Step 4 provider-independent analysis submission.
  app.use("/api", analysisRouter);
  app.use("/api", internalMediaRouter);

  // Legacy Phase-2 clip upload path — disabled in production by default.
  if (config.internal.legacyUploadEnabled) {
    app.use("/api", uploadsRouter);
    app.use("/api", clipsRouter);
  }

  if (isE2eMode()) {
    app.use("/api", createE2eRouter());
  }

  // 404
  app.use((_req, res) => {
    res.status(404).json({ error: "not_found", message: "No such endpoint." });
  });

  // Central error handler — never leak stacks, SQL, or secrets in production.
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err && typeof err === "object" && (err as { type?: string }).type === "entity.too.large") {
      res.status(413).json({
        error: "oversized_payload",
        message: "Request body exceeds the size limit.",
      });
      return;
    }
    if (err instanceof Error && err.message === "CORS_ORIGIN_DENIED") {
      res.status(403).json({ error: "CORS_REJECTED", message: "Origin not allowed." });
      return;
    }
    const message = publicErrorMessage(err);
    console.error("[chelcoach-api] error:", publicErrorMessage(err, "internal_error"));
    res.status(500).json({ error: "internal_error", message });
  });

  return app;
}
