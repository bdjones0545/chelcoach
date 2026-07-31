/**
 * Postgres-backed gameplay profile repository (when DATABASE_URL is set).
 */
import { eq } from "drizzle-orm";
import { getDb } from "../db/client";
import { gameplayProfiles } from "../db/schema";
import {
  defaultGameplayProfile,
  gameplayProfileSchema,
  type GameplayProfile,
  type GameplayProfileUpdate,
} from "../scottyContract";
import type { ProfileRepository } from "./repository";

function rowToProfile(row: typeof gameplayProfiles.$inferSelect): GameplayProfile {
  return gameplayProfileSchema.parse({
    userId: row.userId,
    preferredPlatform: row.preferredPlatform,
    consoleGeneration: row.consoleGeneration ?? undefined,
    preferredControlScheme: row.preferredControlScheme,
    primaryPosition: row.primaryPosition,
    commonGameMode: row.commonGameMode,
    defaultIndicatorColor: row.defaultIndicatorColor,
    defaultTeamSide: row.defaultTeamSide ?? undefined,
    lastSelectedGameId: row.lastSelectedGameId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });
}

export class DrizzleProfileRepository implements ProfileRepository {
  async getOrCreate(userId: string): Promise<GameplayProfile> {
    const db = getDb();
    const [existing] = await db
      .select()
      .from(gameplayProfiles)
      .where(eq(gameplayProfiles.userId, userId))
      .limit(1);
    if (existing) return rowToProfile(existing);

    const created = defaultGameplayProfile(userId, new Date().toISOString());
    const [row] = await db
      .insert(gameplayProfiles)
      .values({
        userId: created.userId,
        preferredPlatform: created.preferredPlatform,
        consoleGeneration: created.consoleGeneration,
        preferredControlScheme: created.preferredControlScheme,
        primaryPosition: created.primaryPosition,
        commonGameMode: created.commonGameMode,
        defaultIndicatorColor: created.defaultIndicatorColor ?? null,
        defaultTeamSide: created.defaultTeamSide,
        lastSelectedGameId: created.lastSelectedGameId ?? null,
        createdAt: new Date(created.createdAt),
        updatedAt: new Date(created.updatedAt),
      })
      .returning();
    return rowToProfile(row);
  }

  async update(userId: string, patch: GameplayProfileUpdate): Promise<GameplayProfile> {
    const current = await this.getOrCreate(userId);
    const next = gameplayProfileSchema.parse({
      ...current,
      ...patch,
      userId,
      updatedAt: new Date().toISOString(),
    });
    const db = getDb();
    const [row] = await db
      .update(gameplayProfiles)
      .set({
        preferredPlatform: next.preferredPlatform,
        consoleGeneration: next.consoleGeneration,
        preferredControlScheme: next.preferredControlScheme,
        primaryPosition: next.primaryPosition,
        commonGameMode: next.commonGameMode,
        defaultIndicatorColor: next.defaultIndicatorColor ?? null,
        defaultTeamSide: next.defaultTeamSide,
        lastSelectedGameId: next.lastSelectedGameId ?? null,
        updatedAt: new Date(next.updatedAt),
      })
      .where(eq(gameplayProfiles.userId, userId))
      .returning();
    return rowToProfile(row);
  }
}
