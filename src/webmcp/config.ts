/**
 * Where the WebMCP runtime gets its switches.
 *
 * Both default to off: an unset environment behaves exactly as it did before
 * WebMCP was added, so enabling agent tooling is always a deliberate act.
 *
 *   VITE_WEBMCP_ENABLED=true    register this app's tools
 *   VITE_WEBMCP_POLYFILL=true   also serve them to browsers without native
 *                               WebMCP, at the cost of a lazily-loaded chunk
 */
import type { WebMcpRuntimeConfig } from "./runtime";

function flag(value: unknown): boolean {
  return value === "true" || value === true;
}

export function webMcpConfig(): WebMcpRuntimeConfig {
  return {
    enabled: flag(import.meta.env.VITE_WEBMCP_ENABLED),
    polyfill: flag(import.meta.env.VITE_WEBMCP_POLYFILL),
  };
}
