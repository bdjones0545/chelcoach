import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { describe, it } from "node:test";
import { resolve } from "node:path";

describe(".env gitignore (Step 10.1A)", () => {
  it(".env remains ignored by git", () => {
    const root = resolve(import.meta.dirname, "../../..");
    const out = execSync("git check-ignore -v .env", { cwd: root, encoding: "utf8" });
    assert.match(out, /\.env/);
  });
});
