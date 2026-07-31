#!/usr/bin/env node
/**
 * Apply Supabase Storage RLS SQL (repository-managed).
 * Usage: npm run apply:supabase-storage-rls
 */
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const result = spawnSync(
  "npx",
  ["tsx", resolve(here, "../src/storage/applyStorageRls.ts")],
  { stdio: "inherit", env: process.env },
);
process.exit(result.status ?? 1);
