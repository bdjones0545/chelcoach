/**
 * WebMCP runtime bootstrap.
 *
 * WebMCP (https://github.com/webmachinelearning/webmcp) lets a page publish its
 * own functionality to AI agents as callable tools via `document.modelContext`.
 * The API is native in Chrome's origin trial (149-156) and absent everywhere
 * else, so this module feature-detects it and only falls back to the
 * `@mcp-b/global` polyfill when the app explicitly opts in.
 *
 * Three properties this module is responsible for:
 *
 *  1. Off by default. Nothing registers unless the app passes `enabled: true`,
 *     which each app derives from an environment flag.
 *  2. Zero cost on the default path. The polyfill is only ever reached through
 *     a dynamic `import()`, so it lands in its own chunk that unflagged builds
 *     never fetch.
 *  3. Never breaks the page. Every failure here is logged and swallowed: a
 *     browser without WebMCP, a blocked chunk, or a throwing tool must not
 *     take the app down with it.
 */
import type { InputSchema, ModelContext, ModelContextTool } from "@mcp-b/webmcp-types";

/**
 * A tool this app can register.
 *
 * `inputSchema` is required rather than optional: `registerTool` is overloaded
 * on whether a schema is present, and a union of both shapes matches neither
 * overload. Every tool built here declares one, so requiring it costs nothing.
 */
export type WebMcpTool = ModelContextTool<Record<string, unknown>, unknown, string> & {
  inputSchema: InputSchema;
};

export type WebMcpRuntimeConfig = {
  /** Master switch. Registration is a no-op when false. */
  enabled: boolean;
  /**
   * Load the `@mcp-b/global` polyfill when the browser has no native
   * `document.modelContext`. Costs a lazily-fetched chunk when it fires.
   */
  polyfill: boolean;
};

/** Largest tool result we will hand an agent, in characters. */
const MAX_RESULT_CHARS = 16_000;

let polyfillLoad: Promise<void> | null = null;

function nativeModelContext(): ModelContext | null {
  if (typeof document === "undefined") return null;
  const candidate = document.modelContext;
  return typeof candidate?.registerTool === "function" ? candidate : null;
}

/**
 * Resolve a usable ModelContext, loading the polyfill if allowed. Returns null
 * when WebMCP is unavailable, which is the normal case in most browsers.
 */
async function resolveModelContext(polyfill: boolean): Promise<ModelContext | null> {
  const native = nativeModelContext();
  if (native) return native;
  if (!polyfill) return null;

  // `@mcp-b/global` installs itself on `document.modelContext` as an import
  // side effect, and no-ops when a native implementation is already present.
  polyfillLoad ??= import("@mcp-b/global").then(() => undefined);
  await polyfillLoad;
  return nativeModelContext();
}

/**
 * Register a set of tools for as long as the returned disposer is uncalled.
 *
 * Synchronous by design so it can be returned directly from a React effect;
 * the async registration it kicks off checks the abort signal before every
 * step, so a disposer called during the in-flight window still wins.
 */
export function registerWebMcpTools(
  tools: readonly WebMcpTool[],
  config: WebMcpRuntimeConfig,
): () => void {
  const controller = new AbortController();

  if (config.enabled && tools.length > 0) {
    void (async () => {
      try {
        const modelContext = await resolveModelContext(config.polyfill);
        if (!modelContext || controller.signal.aborted) return;
        for (const tool of tools) {
          if (controller.signal.aborted) return;
          await modelContext.registerTool(tool, { signal: controller.signal });
        }
      } catch (error) {
        console.warn("[webmcp] tool registration failed", error);
      }
    })();
  }

  return () => {
    controller.abort();
  };
}

function toText(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

function truncate(text: string): string {
  if (text.length <= MAX_RESULT_CHARS) return text;
  return `${text.slice(0, MAX_RESULT_CHARS)}\n\n[truncated: ${
    text.length - MAX_RESULT_CHARS
  } more characters. Narrow the query to see the rest.]`;
}

export type ReadOnlyToolSpec<TInput extends Record<string, unknown>> = {
  name: string;
  title?: string;
  description: string;
  inputSchema?: Record<string, unknown>;
  /**
   * Set when the result can contain text authored by someone other than the
   * current user, so the calling agent knows to treat it as data rather than
   * instructions.
   */
  untrustedContent?: boolean;
  /** The read. Must not mutate application state. */
  read: (input: TInput) => unknown | Promise<unknown>;
};

/**
 * Build a read-only tool.
 *
 * This is the only tool constructor the app uses, and it hard-codes
 * `readOnlyHint: true`. A tool that mutates state cannot be expressed through
 * it, which is deliberate: exposing write paths to an agent is a separate
 * decision from exposing reads, and should not be reachable by accident.
 */
export function defineReadOnlyTool<TInput extends Record<string, unknown> = Record<string, unknown>>(
  spec: ReadOnlyToolSpec<TInput>,
): WebMcpTool {
  return {
    name: spec.name,
    title: spec.title,
    description: spec.description,
    inputSchema: spec.inputSchema ?? { type: "object", properties: {} },
    annotations: {
      readOnlyHint: true,
      untrustedContentHint: spec.untrustedContent ?? false,
    },
    async execute(input) {
      try {
        const result = await spec.read((input ?? {}) as TInput);
        return { content: [{ type: "text", text: truncate(toText(result)) }] };
      } catch (error) {
        // Surface the failure to the agent rather than rejecting, so a bad
        // argument reads as a recoverable tool error instead of a dead tool.
        return {
          content: [
            {
              type: "text",
              text: `Tool "${spec.name}" failed: ${
                error instanceof Error ? error.message : String(error)
              }`,
            },
          ],
          isError: true,
        };
      }
    },
  };
}
