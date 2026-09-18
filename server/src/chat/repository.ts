/**
 * Chat turns for "Ask Scottie", persisted per analysis so a conversation survives reload.
 * In-memory for tests/dev; Drizzle in production (persistence.ts wires it like the others).
 */
import { and, eq, gte, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { getDb } from "../db/client";
import { scottyChatMessages } from "../db/schema";

export type ChatRole = "user" | "assistant";

export interface ChatMessageRecord {
  id: string;
  applicationRequestId: string;
  ownerId: string;
  role: ChatRole;
  content: string;
  model: string | null;
  createdAt: string;
}

export interface ChatRepository {
  append(input: Omit<ChatMessageRecord, "id" | "createdAt">): Promise<ChatMessageRecord>;
  /** Oldest first, bounded. */
  listByRequest(applicationRequestId: string, limit: number): Promise<ChatMessageRecord[]>;
  /** User-authored turns by this owner since `sinceIso` — the daily chat quota reads this. */
  countUserTurnsSince(ownerId: string, sinceIso: string): Promise<number>;
}

export class InMemoryChatRepository implements ChatRepository {
  private rows: ChatMessageRecord[] = [];

  async append(input: Omit<ChatMessageRecord, "id" | "createdAt">): Promise<ChatMessageRecord> {
    const rec: ChatMessageRecord = { ...input, id: randomUUID(), createdAt: new Date().toISOString() };
    this.rows.push(rec);
    return { ...rec };
  }

  async listByRequest(applicationRequestId: string, limit: number): Promise<ChatMessageRecord[]> {
    return this.rows
      .filter((r) => r.applicationRequestId === applicationRequestId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .slice(-limit)
      .map((r) => ({ ...r }));
  }

  async countUserTurnsSince(ownerId: string, sinceIso: string): Promise<number> {
    const since = new Date(sinceIso).getTime();
    return this.rows.filter((r) => r.ownerId === ownerId && r.role === "user" && new Date(r.createdAt).getTime() >= since).length;
  }
}

export class DrizzleChatRepository implements ChatRepository {
  async append(input: Omit<ChatMessageRecord, "id" | "createdAt">): Promise<ChatMessageRecord> {
    const db = getDb();
    const [row] = await db
      .insert(scottyChatMessages)
      .values({
        applicationRequestId: input.applicationRequestId,
        ownerId: input.ownerId,
        role: input.role,
        content: input.content,
        model: input.model,
      })
      .returning();
    return rowToRecord(row!);
  }

  async listByRequest(applicationRequestId: string, limit: number): Promise<ChatMessageRecord[]> {
    const db = getDb();
    // Newest `limit` rows, returned oldest-first.
    const rows = await db
      .select()
      .from(scottyChatMessages)
      .where(eq(scottyChatMessages.applicationRequestId, applicationRequestId))
      .orderBy(sql`${scottyChatMessages.createdAt} desc`)
      .limit(limit);
    return rows.map(rowToRecord).reverse();
  }

  async countUserTurnsSince(ownerId: string, sinceIso: string): Promise<number> {
    const db = getDb();
    const rows = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(scottyChatMessages)
      .where(
        and(
          eq(scottyChatMessages.ownerId, ownerId),
          eq(scottyChatMessages.role, "user"),
          gte(scottyChatMessages.createdAt, new Date(sinceIso)),
        ),
      );
    return rows[0]?.n ?? 0;
  }
}

function rowToRecord(row: typeof scottyChatMessages.$inferSelect): ChatMessageRecord {
  return {
    id: row.id,
    applicationRequestId: row.applicationRequestId,
    ownerId: row.ownerId,
    role: row.role === "assistant" ? "assistant" : "user",
    content: row.content,
    model: row.model ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}


let repo: ChatRepository = new InMemoryChatRepository();

export function getChatRepository(): ChatRepository {
  return repo;
}

export function setChatRepositoryForTests(next: ChatRepository): void {
  repo = next;
}

export function resetChatRepositoryForTests(): void {
  repo = new InMemoryChatRepository();
}
