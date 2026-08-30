import { useEffect, useRef } from "react";

import { webMcpConfig } from "./config";
import { registerWebMcpTools, type WebMcpTool } from "./runtime";

/**
 * Register a set of WebMCP tools for the lifetime of the calling component.
 *
 * Tools are built exactly once, on mount, and read their data through the
 * `getSnapshot` callback they are handed, which always returns the most recent
 * snapshot passed to this hook. That indirection is the point: registration
 * does not churn every time application state changes, but a tool invoked at
 * any moment still sees current data.
 *
 * Everything happens in effects — nothing is built or read during render.
 */
export function useWebMcpTools<TSnapshot>(
  buildTools: (getSnapshot: () => TSnapshot) => readonly WebMcpTool[],
  snapshot: TSnapshot,
): void {
  const snapshotRef = useRef(snapshot);
  const buildRef = useRef(buildTools);
  const toolsRef = useRef<readonly WebMcpTool[] | null>(null);

  useEffect(() => {
    snapshotRef.current = snapshot;
  }, [snapshot]);

  useEffect(() => {
    buildRef.current = buildTools;
  }, [buildTools]);

  useEffect(() => {
    toolsRef.current ??= buildRef.current(() => snapshotRef.current);
    return registerWebMcpTools(toolsRef.current, webMcpConfig());
  }, []);
}
