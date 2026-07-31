import { Router } from "express";
import { isAiConfigured, aiConfig } from "../ai/config";
import { isDbConfigured } from "../db/client";
import { mediaBinariesAvailable } from "../media/binaries";
import { getStorage } from "../storage";

export const healthRouter = Router();

/** Liveness probe for the Replit deployment. */
healthRouter.get("/", (_req, res) => {
  res.json({
    status: "ok",
    service: "chelcoach-api",
    phase: 4,
    dbConfigured: isDbConfigured(),
    storageBackend: getStorage().backend,
    ffmpegAvailable: mediaBinariesAvailable(),
    aiConfigured: isAiConfigured(),
    aiProvider: aiConfig.provider,
    time: new Date().toISOString(),
  });
});
