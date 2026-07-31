/**
 * Constant-time secret comparison and internal auth helpers.
 */
import { timingSafeEqual } from "node:crypto";

export function safeEqualString(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) {
    // Compare against self to keep roughly constant work for wrong lengths.
    timingSafeEqual(ab, ab);
    return false;
  }
  return timingSafeEqual(ab, bb);
}

export function requireInternalSecret(
  provided: string | undefined,
  expected: string,
): boolean {
  if (!expected || isPlaceholderSecret(expected)) return false;
  if (!provided) return false;
  return safeEqualString(provided, expected);
}

const PLACEHOLDERS = new Set([
  "",
  "changeme",
  "secret",
  "password",
  "test",
  "placeholder",
  "xxxxx",
  "your-secret-here",
]);

export function isPlaceholderSecret(value: string): boolean {
  return PLACEHOLDERS.has(value.trim().toLowerCase());
}
