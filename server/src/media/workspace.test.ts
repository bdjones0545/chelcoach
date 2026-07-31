import assert from "node:assert/strict";
import { access, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { cleanupJobWorkspace, createJobWorkspace, writeSourceFile } from "./workspace";

describe("job workspace", () => {
  it("creates a unique directory under os.tmpdir and cleans up after success", async () => {
    const ws = await createJobWorkspace("clip-abc-123");
    assert.ok(ws.root.startsWith(tmpdir()));
    await writeSourceFile(ws, Buffer.from("hello"));
    await writeFile(join(ws.framesDir, "x.jpg"), Buffer.from("x")).catch(async () => {
      const { mkdir } = await import("node:fs/promises");
      await mkdir(ws.framesDir, { recursive: true });
      await writeFile(join(ws.framesDir, "x.jpg"), Buffer.from("x"));
    });
    await cleanupJobWorkspace(ws);
    await assert.rejects(() => access(ws.root));
  });

  it("cleanup after failure is best-effort and safe", async () => {
    const ws = await createJobWorkspace("fail-case");
    await writeSourceFile(ws, Buffer.from(" partial "));
    await cleanupJobWorkspace(ws);
    await cleanupJobWorkspace(ws); // second call must not throw
    await cleanupJobWorkspace(null);
  });
});
