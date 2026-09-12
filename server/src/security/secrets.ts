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

/** Vercel Cron sends one shared bearer for every scheduled route; require real entropy. */
const MIN_PLATFORM_CRON_SECRET_LENGTH = 16;

/**
 * Whether a request is an authenticated platform-cron invocation.
 *
 * Vercel Cron cannot send per-route secrets: it issues `GET` with
 * `Authorization: Bearer <CRON_SECRET>` for every cron path. The per-route secrets stay the
 * operator/manual contract (and must remain distinct from each other); this is the additional
 * scheduler contract. Only GET is accepted, so the shared secret can never drive the POST forms.
 */
export function platformCronSecretAccepted(
  input: { method: string; authorizationHeader: string | undefined },
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (input.method !== "GET") return false;
  const expected = (env.CRON_SECRET ?? "").trim();
  if (expected.length < MIN_PLATFORM_CRON_SECRET_LENGTH || isPlaceholderSecret(expected)) {
    return false;
  }
  const bearer = (input.authorizationHeader ?? "").replace(/^Bearer\s+/i, "").trim();
  return requireInternalSecret(bearer, expected);
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
