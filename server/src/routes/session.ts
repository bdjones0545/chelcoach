import { Router } from "express";
import { createOwnerSession } from "../auth/session";

export const sessionRouter = Router();

/** POST /api/session — mint a pseudonymous owner session (transitional auth). */
sessionRouter.post("/session", (_req, res) => {
  const session = createOwnerSession();
  res.status(201).json({
    token: session.token,
    ownerId: session.ownerId,
    createdAt: session.createdAt,
  });
});
