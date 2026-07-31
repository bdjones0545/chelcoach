/**
 * Shared API base URL — keep free of mock imagery / SVG imports so Node tests
 * can import analysis clients without loading Vite asset modules.
 */

export const API_BASE_URL =
  (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? "http://localhost:3001";

export const USE_BACKEND_REPORTS = import.meta.env.VITE_USE_BACKEND_REPORTS === "true";
