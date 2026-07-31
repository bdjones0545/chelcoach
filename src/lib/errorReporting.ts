/**
 * Extensible client-error reporting hook.
 *
 * Today: console logging only. Swap the body later for Sentry / similar —
 * call sites (ErrorBoundary) should keep calling this single entry point.
 *
 * Production never prints component stacks or full Error objects to avoid
 * leaking implementation details; development logs everything useful.
 */
export interface ClientErrorContext {
  /** React component stack from componentDidCatch, when available. */
  componentStack?: string | null;
  /** Stable tag for the failure site (e.g. "ErrorBoundary"). */
  source?: string;
}

export function reportClientError(error: unknown, context: ClientErrorContext = {}): void {
  const source = context.source ?? "client";

  if (import.meta.env.DEV) {
    console.error(`[ChelCoach] ${source}:`, error);
    if (context.componentStack) {
      console.error(`[ChelCoach] ${source} component stack:`, context.componentStack);
    }
    return;
  }

  // Production: message only — ready for a future observability sink.
  const message = error instanceof Error ? error.message : "Unknown client error";
  console.error(`[ChelCoach] ${source}:`, message);
}
