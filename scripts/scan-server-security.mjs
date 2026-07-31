#!/usr/bin/env node
/**
 * Lightweight repository scan for dangerous production patterns.
 * Accepted exceptions are listed below.
 */
import { execSync } from "node:child_process";

const checks = [
  {
    name: "SCOTTY_SIGNING_SECRET in frontend src",
    cmd: "rg -n 'SCOTTY_SIGNING_SECRET' src --glob '!**/node_modules/**' || true",
    expectEmpty: true,
  },
  {
    name: "DATABASE_URL in frontend src",
    cmd: "rg -n 'DATABASE_URL' src --glob '!**/node_modules/**' || true",
    expectEmpty: true,
  },
  {
    name: "direct anthropic SDK import outside adapter",
    cmd: "rg -n \"from ['\\\"]@anthropic|from ['\\\"]anthropic\" server/src --glob '!**/provider/**' || true",
    expectEmpty: true,
  },
];

let failed = false;
for (const check of checks) {
  const out = execSync(check.cmd, { encoding: "utf8", cwd: process.cwd() }).trim();
  if (check.expectEmpty && out) {
    console.error(`[scan-server-security] FAIL: ${check.name}`);
    console.error(out);
    failed = true;
  } else {
    console.log(`[scan-server-security] OK: ${check.name}`);
  }
}

// Documented accepted exception: provider/config and chelcoachConfig still read process.env
// (centralized). Route files should prefer getChelCoachConfig — warn-only count.
const envReads = execSync(
  "rg -n 'process\\.env' server/src/routes server/src/identification server/src/uploads --glob '!**/*.test.ts' || true",
  { encoding: "utf8" },
).trim();
const envCount = envReads ? envReads.split("\n").filter(Boolean).length : 0;
console.log(`[scan-server-security] process.env in route/service paths: ${envCount} (review)`);

if (failed) process.exit(1);
console.log("[scan-server-security] OK");
