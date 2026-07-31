/**
 * Injectable child-process runner: args arrays only (no shell), timeouts,
 * bounded stdout/stderr capture, and cooperative abort.
 */
import { spawn, type ChildProcess } from "node:child_process";

export interface RunProcessOptions {
  timeoutMs: number;
  maxOutputBytes: number;
  signal?: AbortSignal;
  /** Working directory for the child (optional). */
  cwd?: string;
}

export interface RunProcessResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  signal: NodeJS.Signals | null;
}

export type ProcessRunner = (
  command: string,
  args: readonly string[],
  options: RunProcessOptions,
) => Promise<RunProcessResult>;

function appendBounded(current: string, chunk: Buffer, maxBytes: number): string {
  if (current.length >= maxBytes) return current;
  const next = chunk.toString("utf8");
  const room = maxBytes - current.length;
  return current.length + next.length <= maxBytes ? current + next : current + next.slice(0, room);
}

/** Default runner used in production. Tests inject fakes. */
export const runProcess: ProcessRunner = (command, args, options) => {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(Object.assign(new Error("Aborted"), { name: "AbortError" }));
      return;
    }

    let child: ChildProcess;
    try {
      child = spawn(command, [...args], {
        stdio: ["ignore", "pipe", "pipe"],
        cwd: options.cwd,
        // Never invoke a shell — args are passed directly.
        shell: false,
      });
    } catch (err) {
      reject(err);
      return;
    }

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, options.timeoutMs);

    const onAbort = () => {
      child.kill("SIGKILL");
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout = appendBounded(stdout, chunk, options.maxOutputBytes);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = appendBounded(stderr, chunk, options.maxOutputBytes);
    });

    const finish = (result: RunProcessResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      resolve(result);
    };

    child.on("error", (err) => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      if (!settled) {
        settled = true;
        reject(err);
      }
    });

    child.on("close", (code, signal) => {
      finish({ code, stdout, stderr, timedOut, signal });
    });
  });
};
