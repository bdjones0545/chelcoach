import { Router } from "express";
import { isDbConfigured } from "../db/client";

export const healthRouter = Router();

/** Liveness probe for the Replit deployment. */
healthRouter.get("/", (_req, res) => {
  res.json({
    status: "ok",
    service: "chelcoach-api",
    phase: 0,
    dbConfigured: isDbConfigured(),
    time: new Date().toISOString(),
  });
});
