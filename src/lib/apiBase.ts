/**
 * Shared API base URL — keep free of mock imagery / SVG imports so Node tests
 * can import analysis clients without loading Vite asset modules.
 */

/**
 * Production builds are served from the same Vercel deployment as `/api/*`, so the default is
 * same-origin (an empty base yields relative `/api/...` URLs). Development keeps the separate
 * Express dev server. `VITE_API_BASE_URL` overrides both.
 */
export const API_BASE_URL =
  (import.meta.env.VITE_API_BASE_URL as string | undefined) ??
  (import.meta.env.PROD ? "" : "http://localhost:3001");

export const USE_BACKEND_REPORTS = import.meta.env.VITE_USE_BACKEND_REPORTS === "true";
