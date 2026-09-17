import { Router } from "express";
import { isDbConfigured } from "../db/client";
import { getStorage } from "../storage";

export const healthRouter = Router();

/** Liveness probe. Capability lives in /api/health/readiness, not here. */
healthRouter.get("/", (_req, res) => {
  res.json({
    status: "ok",
    service: "chelcoach-api",
    dbConfigured: isDbConfigured(),
    storageBackend: getStorage().backend,
    time: new Date().toISOString(),
  });
});
