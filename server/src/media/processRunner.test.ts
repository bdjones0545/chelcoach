import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runProcess } from "./processRunner";

describe("runProcess", () => {
  it("captures bounded stdout from a real process", async () => {
    const result = await runProcess("node", ["-e", "process.stdout.write('hello')"], {
      timeoutMs: 5_000,
      maxOutputBytes: 1024,
    });
    assert.equal(result.code, 0);
    assert.equal(result.stdout, "hello");
    assert.equal(result.timedOut, false);
  });

  it("enforces timeout and kills the child", async () => {
    const result = await runProcess("node", ["-e", "setTimeout(() => {}, 30_000)"], {
      timeoutMs: 200,
      maxOutputBytes: 1024,
    });
    assert.equal(result.timedOut, true);
  });

  it("bounds stderr capture", async () => {
    const result = await runProcess(
      "node",
      ["-e", "process.stderr.write('x'.repeat(10_000))"],
      { timeoutMs: 5_000, maxOutputBytes: 64 },
    );
    assert.ok(result.stderr.length <= 64);
  });

  it("returns non-zero exit codes", async () => {
    const result = await runProcess("node", ["-e", "process.exit(7)"], {
      timeoutMs: 5_000,
      maxOutputBytes: 1024,
    });
    assert.equal(result.code, 7);
  });
});
