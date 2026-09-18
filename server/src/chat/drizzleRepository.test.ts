/**
 * Postgres-backed chat repository. Skipped unless CHELCOACH_RUN_PG_TESTS=1 and DATABASE_URL is set.
 */
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { getDb, isDbConfigured } from "../db/client";
import { DrizzleChatRepository } from "./repository";

const runPg = process.env.CHELCOACH_RUN_PG_TESTS === "1" && isDbConfigured();

describe("DrizzleChatRepository (postgres)", { skip: !runPg }, () => {
  const repo = new DrizzleChatRepository();

  beforeEach(async () => {
    await getDb().execute(sql`TRUNCATE TABLE scotty_chat_messages`);
  });

  it("appends turns, lists them oldest-first within a bound, and counts only the owner's user turns", async () => {
    const req = `req-${randomUUID()}`;
    const other = `req-${randomUUID()}`;
    await repo.append({ applicationRequestId: req, ownerId: "own-a", role: "user", content: "one", model: null });
    await repo.append({ applicationRequestId: req, ownerId: "own-a", role: "assistant", content: "reply one", model: "grok-4" });
    await repo.append({ applicationRequestId: req, ownerId: "own-a", role: "user", content: "two", model: null });
    await repo.append({ applicationRequestId: other, ownerId: "own-b", role: "user", content: "elsewhere", model: null });

    const all = await repo.listByRequest(req, 100);
    assert.deepEqual(all.map((m) => m.content), ["one", "reply one", "two"]);
    assert.equal(all[1]!.model, "grok-4");

    const last2 = await repo.listByRequest(req, 2);
    assert.deepEqual(last2.map((m) => m.content), ["reply one", "two"], "newest N, returned oldest-first");

    const since = new Date(Date.now() - 60_000).toISOString();
    assert.equal(await repo.countUserTurnsSince("own-a", since), 2, "assistant turns and other owners do not count");
    assert.equal(await repo.countUserTurnsSince("own-b", since), 1);
    assert.equal(await repo.countUserTurnsSince("own-a", new Date(Date.now() + 60_000).toISOString()), 0);
  });

  it("rejects a role outside user|assistant at the database", async () => {
    await assert.rejects(() =>
      repo.append({ applicationRequestId: "req-x", ownerId: "own-a", role: "system" as never, content: "nope", model: null }),
    );
  });
});
