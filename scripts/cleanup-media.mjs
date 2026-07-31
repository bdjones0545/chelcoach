#!/usr/bin/env node
/**
 * External scheduler entry: POST internal media cleanup.
 * Requires CHELCOACH_CLEANUP_SECRET and API base URL.
 */
const base = process.env.CHELCOACH_API_BASE || "http://127.0.0.1:3001";
const secret = process.env.CHELCOACH_CLEANUP_SECRET;
if (!secret) {
  console.error("CHELCOACH_CLEANUP_SECRET required");
  process.exit(1);
}
const limit = Number(process.env.CHELCOACH_CLEANUP_LIMIT || 50);
const res = await fetch(`${base}/api/internal/media/cleanup`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "x-chelcoach-cleanup-secret": secret,
  },
  body: JSON.stringify({ limit }),
});
const body = await res.json().catch(() => ({}));
if (!res.ok) {
  console.error("cleanup failed", res.status, body);
  process.exit(1);
}
console.log(JSON.stringify(body));
