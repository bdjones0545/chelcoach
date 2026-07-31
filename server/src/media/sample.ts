/**
 * Deterministic, bounded frame-timestamp sampling.
 * Same duration + config → same timestamps. No coaching-moment claims.
 */
import { mediaConfig } from "./config";

export interface SampleOptions {
  maxFrames?: number;
  edgeSkipFraction?: number;
}

/**
 * Pick evenly spaced timestamps across the usable interior of the clip.
 * - Very short clips (< 0.25s): single midpoint sample.
 * - Otherwise: 1..maxFrames evenly distributed, duplicates removed.
 */
export function sampleTimestamps(durationSec: number, options: SampleOptions = {}): number[] {
  if (!Number.isFinite(durationSec) || durationSec <= 0) {
    throw new Error("durationSec must be positive");
  }

  const maxFrames = options.maxFrames ?? mediaConfig.maxFrames;
  const edge = options.edgeSkipFraction ?? mediaConfig.edgeSkipFraction;

  if (durationSec < 0.25) {
    return [roundTs(durationSec / 2)];
  }

  const start = durationSec * edge;
  const end = durationSec * (1 - edge);
  const span = Math.max(end - start, 0.001);

  // Aim for up to maxFrames, but never more than ~1/sec of usable span for short clips.
  const count = Math.min(maxFrames, Math.max(1, Math.round(span) || 1));

  if (count === 1) return [roundTs(start + span / 2)];

  const out: number[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < count; i += 1) {
    const t = roundTs(start + (span * i) / (count - 1));
    // Clamp inside (0, duration) exclusive of the exact end (ffmpeg eof quirks).
    const clamped = Math.min(Math.max(t, 0), Math.max(durationSec - 0.01, 0));
    const key = clamped.toFixed(3);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(clamped);
  }
  return out;
}

function roundTs(n: number): number {
  return Math.round(n * 1000) / 1000;
}
