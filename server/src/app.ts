import cors from "cors";
import express from "express";
import type { NextFunction, Request, Response } from "express";
import { clipsRouter } from "./routes/clips";
import { healthRouter } from "./routes/health";
import { uploadsRouter } from "./routes/uploads";

export function createApp() {
  const app = express();

  // Lock CORS to the app origin(s). Comma-separated CORS_ORIGIN, or allow all in dev.
  const origin = process.env.CORS_ORIGIN?.split(",").map((s) => s.trim());
  app.use(cors(origin ? { origin } : undefined));
  app.use(express.json({ limit: "1mb" }));

  app.use("/api/health", healthRouter);
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
