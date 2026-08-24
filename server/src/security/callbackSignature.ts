import { createHmac, timingSafeEqual } from "node:crypto";

export const SCOTTY_CALLBACK_TIMESTAMP_HEADER = "x-scotty-timestamp";
export const SCOTTY_CALLBACK_SIGNATURE_HEADER = "x-scotty-signature";
export const SCOTTY_CALLBACK_MAX_SKEW_SECONDS = 300;

export class CallbackAuthenticationError extends Error {
  constructor() {
    super("SCOTTY_CALLBACK_AUTHENTICATION_FAILED");
    this.name = "CallbackAuthenticationError";
  }
}

function canonicalBytes(timestamp: string, rawBody: Buffer): Buffer {
  return Buffer.concat([Buffer.from(`${timestamp}.`, "utf8"), rawBody]);
}

export function signScottyCallback(secret: string, timestamp: string, rawBody: Buffer): string {
  return `v1=${createHmac("sha256", secret).update(canonicalBytes(timestamp, rawBody)).digest("hex")}`;
}

export function verifyScottyCallback(input: {
  secret: string;
  timestamp?: string;
  signature?: string;
  rawBody?: Buffer;
  nowMs?: number;
}): boolean {
  const { secret, timestamp, signature, rawBody, nowMs = Date.now() } = input;
  if (!secret || !timestamp || !signature || !rawBody || !/^\d{10}$/.test(timestamp)) return false;
  const timestampSeconds = Number(timestamp);
  if (!Number.isSafeInteger(timestampSeconds)) return false;
  if (Math.abs(Math.floor(nowMs / 1000) - timestampSeconds) > SCOTTY_CALLBACK_MAX_SKEW_SECONDS) {
    return false;
  }
  const match = /^v1=([a-f0-9]{64})$/.exec(signature);
  if (!match) return false;
  const provided = Buffer.from(match[1]!, "hex");
  const expected = Buffer.from(signScottyCallback(secret, timestamp, rawBody).slice(3), "hex");
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}
