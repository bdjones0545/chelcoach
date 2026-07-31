import { Router } from "express";
import { requireOwnerAuth, type AuthedRequest } from "../auth/session";
import { gameplayProfileUpdateSchema } from "../scottyContract";
import { getProfileRepository } from "../profile/repository";

export const profileRouter = Router();

profileRouter.get("/gameplay-profile", requireOwnerAuth, async (req, res) => {
  const { ownerId } = req as AuthedRequest;
  const profile = await getProfileRepository().getOrCreate(ownerId);
  res.json(profile);
});

profileRouter.put("/gameplay-profile", requireOwnerAuth, async (req, res) => {
  const { ownerId } = req as AuthedRequest;
  const parsed = gameplayProfileUpdateSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "INVALID_REQUEST", message: "Invalid profile update." });
    return;
  }
  const profile = await getProfileRepository().update(ownerId, parsed.data);
  res.json(profile);
});
