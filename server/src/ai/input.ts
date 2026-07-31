/**
 * Internal AI-analysis input contract.
 * Built from ExtractionResult frame paths before workspace cleanup.
 * Never includes filesystem paths in provider-visible payloads.
 */
import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { ExtractionResult } from "../media/types";
import { aiConfig } from "./config";
import { AiAnalysisError } from "./errors";
import { ANALYSIS_CONTRACT_VERSION, PROMPT_VERSION, RUBRIC_VERSION } from "./versions";

const frameImageSchema = z.object({
  index: z.number().int().nonnegative(),
  timestampSec: z.number().nonnegative(),
  mediaType: z.literal("image/jpeg"),
  /** Raw JPEG bytes — released after the provider call. */
  bytes: z.instanceof(Buffer),
  byteLength: z.number().int().positive(),
});

export const aiAnalysisInputSchema = z.object({
  clipId: z.string().min(1).max(128),
  durationSec: z.number().positive(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  fps: z.number().nonnegative(),
  timestampsSec: z.array(z.number().nonnegative()),
  frames: z.array(frameImageSchema).min(1),
  contractVersion: z.string().min(1),
  rubricVersion: z.string().min(1),
  promptVersion: z.string().min(1),
  contextualHints: z.array(z.string().max(200)).max(5).optional(),
});

export type AiAnalysisInput = z.infer<typeof aiAnalysisInputSchema>;

export interface BuildAiInputOptions {
  maxFrames?: number;
  maxImageBytes?: number;
  maxTotalImageBytes?: number;
  contextualHints?: string[];
}

/**
 * Read extracted JPEG frames into a validated AI input.
 * Preserves chronological order; associates each frame with its timestamp.
 */
export async function buildAiAnalysisInput(
  extraction: ExtractionResult,
  options: BuildAiInputOptions = {},
): Promise<AiAnalysisInput> {
  const maxFrames = options.maxFrames ?? aiConfig.maxFrames;
  const maxImageBytes = options.maxImageBytes ?? aiConfig.maxImageBytes;
  const maxTotalImageBytes = options.maxTotalImageBytes ?? aiConfig.maxTotalImageBytes;

  const ordered = [...extraction.frames]
    .filter((f) => f.path)
    .sort((a, b) => a.timestampSec - b.timestampSec || a.index - b.index)
    .slice(0, maxFrames);

  if (ordered.length === 0) {
    throw new AiAnalysisError("AI_FRAME_UNREADABLE", "no frame paths available", {
      retryable: false,
    });
  }

  let total = 0;
  const frames: AiAnalysisInput["frames"] = [];

  for (const frame of ordered) {
    let bytes: Buffer;
    try {
      bytes = await readFile(frame.path);
    } catch (err) {
      throw new AiAnalysisError(
        "AI_FRAME_UNREADABLE",
        err instanceof Error ? err.message : "read failed",
        { retryable: false },
      );
    }
    if (!bytes.length) {
      throw new AiAnalysisError("AI_FRAME_UNREADABLE", "empty frame", { retryable: false });
    }
    if (bytes.length > maxImageBytes) {
      throw new AiAnalysisError(
        "AI_REQUEST_TOO_LARGE",
        `frame ${frame.index} exceeds per-image limit`,
        { retryable: false },
      );
    }
    total += bytes.length;
    if (total > maxTotalImageBytes) {
      throw new AiAnalysisError("AI_REQUEST_TOO_LARGE", "total image bytes exceed limit", {
        retryable: false,
      });
    }
    frames.push({
      index: frame.index,
      timestampSec: frame.timestampSec,
      mediaType: "image/jpeg",
      bytes,
      byteLength: bytes.length,
    });
  }

  const input: AiAnalysisInput = {
    clipId: extraction.clipId,
    durationSec: extraction.metadata.durationSec,
    width: extraction.metadata.width,
    height: extraction.metadata.height,
    fps: extraction.metadata.fps,
    timestampsSec: frames.map((f) => f.timestampSec),
    frames,
    contractVersion: ANALYSIS_CONTRACT_VERSION,
    rubricVersion: RUBRIC_VERSION,
    promptVersion: PROMPT_VERSION,
    ...(options.contextualHints ? { contextualHints: options.contextualHints } : {}),
  };

  return aiAnalysisInputSchema.parse(input);
}

/** Clear frame buffers after the provider request finishes. */
export function releaseAiInputBuffers(input: AiAnalysisInput): void {
  for (const frame of input.frames) {
    frame.bytes = Buffer.alloc(0);
  }
}

/** Format seconds as m:ss for coaching timestamps. */
export function formatTimestamp(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${r.toString().padStart(2, "0")}`;
}
