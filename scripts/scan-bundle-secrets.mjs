#!/usr/bin/env node
/**
 * Fail if production frontend bundles contain server-only secrets / URLs.
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const distDir = join(process.cwd(), "dist", "assets");
const patterns = [
  { name: "SCOTTY_SIGNING_SECRET", re: /SCOTTY_SIGNING_SECRET/ },
  { name: "SCOTTY_BASE_URL value", re: /SCOTTY_BASE_URL\s*[:=]/ },
  { name: "DATABASE_URL", re: /DATABASE_URL\s*[:=]/ },
  { name: "SUPABASE_SERVICE_ROLE_KEY", re: /SUPABASE_SERVICE_ROLE_KEY/ },
  { name: "service_role JWT role claim leakage", re: /"role":"service_role"/ },
  { name: "CHELCOACH_RECONCILE_SECRET", re: /CHELCOACH_RECONCILE_SECRET/ },
  { name: "CHELCOACH_CLEANUP_SECRET", re: /CHELCOACH_CLEANUP_SECRET/ },
  { name: "CHELCOACH_CALLBACK_SECRET", re: /CHELCOACH_CALLBACK_SECRET/ },
  { name: "CHELCOACH_E2E_SECRET", re: /CHELCOACH_E2E_SECRET/ },
  { name: "Anthropic key prefix", re: /sk-ant-/ },
  { name: "internal reconcile path as constant", re: /\/api\/internal\/analysis\/reconcile/ },
  { name: "internal cleanup path as constant", re: /\/api\/internal\/media\/cleanup/ },
];

async function main() {
  let files;
  try {
    files = (await readdir(distDir)).filter((f) => f.endsWith(".js"));
  } catch {
    console.error("[scan-bundle-secrets] dist/assets missing — run npm run build first");
    process.exit(2);
  }
  const findings = [];
  for (const file of files) {
    const text = await readFile(join(distDir, file), "utf8");
    for (const p of patterns) {
      if (p.re.test(text)) {
        findings.push(`${file}: ${p.name}`);
      }
    }
  }
  if (findings.length) {
    console.error("[scan-bundle-secrets] FAIL");
    for (const f of findings) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log(`[scan-bundle-secrets] OK (${files.length} assets scanned)`);
}

main();
