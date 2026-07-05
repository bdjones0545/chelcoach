import { Router } from "express";
import { isDbConfigured } from "../db/client";
import { getStorage } from "../storage";

export const healthRouter = Router();

/** Liveness probe for the Replit deployment. */
healthRouter.get("/", (_req, res) => {
  res.json({
    status: "ok",
    service: "chelcoach-api",
    phase: 2,
    dbConfigured: isDbConfigured(),
    storageBackend: getStorage().backend,
    time: new Date().toISOString(),
  });
});
