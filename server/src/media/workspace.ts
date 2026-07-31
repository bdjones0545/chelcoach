/**
 * Per-job temporary workspace under the OS temp dir.
 * Never uses user-provided filenames as paths.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface JobWorkspace {
  /** Absolute root of the job workspace. */
  root: string;
  sourcePath: string;
  framesDir: string;
}

/** Create `chelcoach-<clipIdPrefix>-XXXXXX` under os.tmpdir(). */
export async function createJobWorkspace(clipId: string): Promise<JobWorkspace> {
  const safe = clipId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 12) || "job";
  const root = await mkdtemp(join(tmpdir(), `chelcoach-${safe}-`));
  const framesDir = join(root, "frames");
  // frames dir created lazily by extract; ensure source path is inside root only.
  return {
    root,
    sourcePath: join(root, "source.bin"),
    framesDir,
  };
}

/** Write opaque source bytes into the workspace (never named from user input). */
export async function writeSourceFile(workspace: JobWorkspace, data: Buffer): Promise<string> {
  await writeFile(workspace.sourcePath, data);
  return workspace.sourcePath;
}

/** Best-effort recursive cleanup. Never throws to callers (logs instead). */
export async function cleanupJobWorkspace(workspace: JobWorkspace | null | undefined): Promise<void> {
  if (!workspace?.root) return;
  // Guard: only delete under the OS temp directory.
  const tempRoot = tmpdir();
  if (!workspace.root.startsWith(tempRoot)) {
    console.error("[chelcoach-api] refused to cleanup path outside tmpdir:", workspace.root);
    return;
  }
  try {
    await rm(workspace.root, { recursive: true, force: true });
  } catch (err) {
    console.error("[chelcoach-api] workspace cleanup failed:", err instanceof Error ? err.message : err);
  }
}
