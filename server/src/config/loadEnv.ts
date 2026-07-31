/**
 * Minimal .env loader for server scripts and local boot.
 * Does not override existing process.env values.
 * Never logs file contents or secret values.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

function parseEnvFile(contents: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of contents.split(/\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (/^[A-Z_][A-Z0-9_]*$/i.test(key)) out[key] = value;
  }
  return out;
}

/** Load workspace and server .env files into process.env (non-destructive). */
export function loadLocalEnvFiles(cwd = process.cwd()): string[] {
  // Skip under Vitest so unit tests never attach to a live Supabase DATABASE_URL
  // from the operator's local .env.
  if (process.env.VITEST === "true" || process.env.NODE_ENV === "test") {
    return [];
  }
  const candidates = [
    resolve(cwd, ".env"),
    resolve(cwd, "../.env"),
    resolve(cwd, "server/.env"),
  ];
  const loaded: string[] = [];
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    const parsed = parseEnvFile(readFileSync(path, "utf8"));
    for (const [k, v] of Object.entries(parsed)) {
      if (process.env[k] === undefined) process.env[k] = v;
    }
    loaded.push(path);
  }
  return loaded;
}
