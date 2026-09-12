/**
 * Production controlled-player identification: a vision model over real sampled frames.
 *
 * The service extracts the evidence frames first and passes them in, so every candidate's
 * bounding box is tied to a frame the user will actually see. Model output is normalized and
 * bounded here; nothing the model says is trusted beyond the frames it was shown.
 */
import { getVisionModelClient, type IdentificationModelOutput, type VisionModelClient } from "../ai/modelClient";
import { ProviderError } from "../provider/errors";
import { confidenceLabelFromScore, type GameContext, type PlayerContext, type TrustedMediaMetadata } from "../scottyContract";
import type { ExtractedConfirmationFrame } from "./extractor";
import {
  FixtureControlledPlayerIdentifier,
  setControlledPlayerIdentifierForTests,
  type ControlledPlayerIdentificationResult,
  type ControlledPlayerIdentifier,
  type FixtureCandidateDraft,
  type FixtureScenario,
} from "./fixtureIdentifier";

const MAX_CANDIDATES = 4;
const POSITIONS = new Set(["C", "LW", "RW", "LD", "RD", "G", "unknown"]);
const SIDES = new Set(["home", "away", "unknown"]);

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

function normalizeBox(b: { x: number; y: number; width: number; height: number }) {
  const x = clamp01(b.x);
  const y = clamp01(b.y);
  const width = Math.max(0.01, Math.min(clamp01(b.width), 1 - x));
  const height = Math.max(0.01, Math.min(clamp01(b.height), 1 - y));
  return { x, y, width, height };
}

function normalizeJersey(n: number | null | undefined): number | null {
  if (n === null || n === undefined || !Number.isFinite(n)) return null;
  const i = Math.trunc(n);
  return i >= 0 && i <= 99 ? i : null;
}

function normalizeColor(c: string | null | undefined): string | null {
  const v = (c ?? "").trim().toLowerCase().slice(0, 40);
  return v ? v : null;
}

function clip(s: string | undefined, max: number): string {
  return (s ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

/** Pure mapping from model output to the identifier result (exported for tests). */
export function normalizeIdentificationOutput(
  output: IdentificationModelOutput,
  frames: Array<{ timestampSec: number }>,
): Omit<ControlledPlayerIdentificationResult, "provider"> {
  const candidates: FixtureCandidateDraft[] = [];
  let droppedCandidates = 0;
  for (const c of output.candidates) {
    if (candidates.length >= MAX_CANDIDATES) break;
    const frame = frames[Math.trunc(c.frameIndex)];
    if (!frame) {
      droppedCandidates += 1;
      continue;
    }
    candidates.push({
      displayLabel: clip(c.displayLabel, 80) || `Player ${candidates.length + 1}`,
      timestampSec: frame.timestampSec,
      boundingBox: normalizeBox(c.boundingBox),
      position: POSITIONS.has(c.position) ? c.position : "unknown",
      jerseyNumber: normalizeJersey(c.jerseyNumber),
      indicatorColor: normalizeColor(c.indicatorColor),
      teamSide: SIDES.has(c.teamSide) ? c.teamSide : "unknown",
      confidence: clamp01(c.confidence),
      evidenceSummary: clip(c.evidenceSummary, 300) || "Candidate skater",
    });
  }

  const uncertainties = output.uncertainties.map((u) => clip(u, 300)).filter(Boolean).slice(0, 18);
  if (droppedCandidates > 0) uncertainties.push("Some candidates referenced frames that were not sampled and were dropped");

  const top = candidates[0];
  let detected = output.detected && candidates.length > 0;
  let confidence = clamp01(output.confidence);
  if (!detected) {
    confidence = Math.min(confidence, 0.3);
    if (candidates.length === 0) uncertainties.push("No skater matching the provided context was located in the sampled frames");
  }
  if (detected && candidates.length > 1) {
    // Several plausible skaters — never auto-accept on a crowded frame.
    confidence = Math.min(confidence, 0.74);
  }

  const predicted = output.predicted;
  const position = POSITIONS.has(predicted.position) ? predicted.position : (top?.position ?? "unknown");
  return {
    detected,
    confidence,
    confidenceLabel: confidenceLabelFromScore(confidence),
    position: position as ControlledPlayerIdentificationResult["position"],
    jerseyNumber: normalizeJersey(predicted.jerseyNumber) ?? top?.jerseyNumber ?? null,
    indicatorColor: normalizeColor(predicted.indicatorColor) ?? top?.indicatorColor ?? null,
    teamSide: (SIDES.has(predicted.teamSide) ? predicted.teamSide : (top?.teamSide ?? "unknown")) as ControlledPlayerIdentificationResult["teamSide"],
    evidenceTimestampsSec: [...new Set(frames.map((f) => f.timestampSec))],
    uncertainties: uncertainties.slice(0, 20),
    confirmationRequired: !detected || candidates.length !== 1,
    candidates,
  };
}

export class ClaudeVisionControlledPlayerIdentifier implements ControlledPlayerIdentifier {
  readonly requiresFrames = true;

  constructor(private opts: { model?: VisionModelClient } = {}) {}

  async identify(input: {
    uploadId: string;
    ownerId: string;
    gameContext: GameContext;
    playerContext: PlayerContext;
    mediaMetadata: TrustedMediaMetadata;
    fixtureScenario?: FixtureScenario;
    frames?: ExtractedConfirmationFrame[];
  }): Promise<ControlledPlayerIdentificationResult> {
    const model = this.opts.model ?? getVisionModelClient();
    const frames = input.frames ?? [];
    const failed = (errorMessage: string, uncertainty: string): ControlledPlayerIdentificationResult => ({
      provider: "claude_vision",
      detected: false,
      confidence: 0,
      confidenceLabel: "insufficient",
      position: "unknown",
      jerseyNumber: null,
      indicatorColor: null,
      teamSide: "unknown",
      evidenceTimestampsSec: frames.map((f) => f.timestampSec),
      uncertainties: [uncertainty],
      confirmationRequired: false,
      failed: true,
      errorMessage,
      candidates: [],
    });

    if (!model.configured) {
      return failed("The identification service is not configured.", "Vision model credentials missing");
    }
    if (frames.length === 0) {
      return failed("No frames were available for identification.", "Frame extraction produced no frames");
    }

    try {
      const { output } = await model.identifyControlledPlayer({
        frames: frames.map((f, index) => ({ index, timestampSec: f.timestampSec, jpegBase64: f.bytes.toString("base64") })),
        context: {
          gameContext: input.gameContext,
          playerContext: input.playerContext,
          durationSec: input.mediaMetadata.durationSec,
        },
      });
      return { provider: "claude_vision", ...normalizeIdentificationOutput(output, frames) };
    } catch (err) {
      const message =
        err instanceof ProviderError && err.code === "RATE_LIMITED"
          ? "The identification service is busy. Try again in a minute."
          : "We couldn't identify your controlled player.";
      console.error(
        `[chelcoach-identity] event=vision_identification_failed uploadId=${input.uploadId} errorCode=${err instanceof ProviderError ? err.code : "ANALYSIS_FAILED"}`,
      );
      return failed(message, "Vision identification call failed");
    }
  }
}

export type IdentifierMode = "claude_vision" | "fixture";

export function resolveIdentifierMode(env: NodeJS.ProcessEnv = process.env): IdentifierMode {
  const raw = (env.CHELCOACH_PLAYER_IDENTIFIER ?? "").trim();
  if (raw === "claude_vision" || raw === "fixture") return raw;
  // Fixtures are deterministic stand-ins; production must never serve them as identification.
  return env.NODE_ENV === "production" ? "claude_vision" : "fixture";
}

/** Boot-time selection, mirroring the frame extractor's. */
export function configureDefaultControlledPlayerIdentifier(env: NodeJS.ProcessEnv = process.env): IdentifierMode {
  const mode = resolveIdentifierMode(env);
  setControlledPlayerIdentifierForTests(
    mode === "claude_vision" ? new ClaudeVisionControlledPlayerIdentifier() : new FixtureControlledPlayerIdentifier(),
  );
  return mode;
}
