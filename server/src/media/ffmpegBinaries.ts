/**
 * Locate ffmpeg / ffprobe for the current process.
 *
 * Resolution order, first hit wins:
 *   1. FFMPEG_PATH / FFPROBE_PATH (operator override)
 *   2. the static binaries shipped by @ffmpeg-installer / @ffprobe-installer (platform packages
 *      are optional dependencies, so the right one is installed per host — linux-x64 on Vercel,
 *      darwin-arm64 on an Apple laptop)
 *   3. a bare name on PATH (VM / CI images with ffmpeg installed)
 *
 * On Vercel the function bundle is read-only and files included via `includeFiles` do not always
 * keep their execute bit, so a non-executable static binary is copied once into the writable temp
 * directory and marked executable there.
 */
import { accessSync, chmodSync, constants, copyFileSync, existsSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type MediaBinary = "ffmpeg" | "ffprobe";

const require = createRequire(import.meta.url);
const resolved = new Map<MediaBinary, string | null>();

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function installerPath(kind: MediaBinary): string | null {
  const pkg = kind === "ffmpeg" ? "@ffmpeg-installer/ffmpeg" : "@ffprobe-installer/ffprobe";
  try {
    const mod = require(pkg) as { path?: string };
    return typeof mod.path === "string" && existsSync(mod.path) ? mod.path : null;
  } catch {
    return null;
  }
}

/** Copy a non-executable static binary somewhere writable and mark it executable. */
function ensureExecutable(kind: MediaBinary, path: string): string {
  if (isExecutable(path)) return path;
  const dir = join(tmpdir(), "chelcoach-bin");
  const target = join(dir, kind);
  if (!isExecutable(target)) {
    mkdirSync(dir, { recursive: true });
    copyFileSync(path, target);
    chmodSync(target, 0o755);
  }
  return target;
}

/**
 * Absolute path (or bare command name when only PATH lookup is possible) for a media binary, or
 * null when nothing usable exists. Cached per process; call `resetMediaBinaryCacheForTests` to
 * re-resolve after changing the environment.
 */
export function resolveMediaBinary(kind: MediaBinary): string | null {
  if (resolved.has(kind)) return resolved.get(kind) ?? null;
  const override = (kind === "ffmpeg" ? process.env.FFMPEG_PATH : process.env.FFPROBE_PATH)?.trim();
  let path: string | null = null;
  if (override) {
    path = existsSync(override) ? ensureExecutable(kind, override) : override;
  } else {
    const installed = installerPath(kind);
    path = installed ? ensureExecutable(kind, installed) : kind;
  }
  resolved.set(kind, path);
  return path;
}

export function resetMediaBinaryCacheForTests(): void {
  resolved.clear();
}
