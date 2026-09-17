/**
 * Controlled-player identification from the user's own hints — no model call.
 *
 * Production runs analysis on the Scottie gateway, which does its own visual identification and
 * pauses for confirmation when unsure (`awaiting_player_confirmation`). ChelCoach's local vision
 * pass needs an Anthropic key the deployment does not hold, so this identifier stands in: it
 * turns what the user told us on the Upload screen (position, jersey, indicator color, side)
 * into one candidate on a real sampled frame and ALWAYS asks the user to confirm it. It never
 * claims to have seen anything — the confidence is fixed below the auto-accept threshold and
 * the uncertainty says so in plain words.
 */
import { confidenceLabelFromScore, type GameContext, type PlayerContext, type TrustedMediaMetadata } from "../scottyContract";
import type { ExtractedConfirmationFrame } from "./extractor";
import type { ControlledPlayerIdentificationResult, ControlledPlayerIdentifier, FixtureScenario } from "./fixtureIdentifier";

/** Below the default 0.75 auto-accept threshold by design: a hint is not an observation. */
export const USER_HINTS_CONFIDENCE = 0.5;

/** A centered region — the user drags their eye to the indicator, not to a box we cannot place. */
const CENTER_BOX = { x: 0.3, y: 0.25, width: 0.4, height: 0.5 } as const;

const POSITIONS = new Set(["C", "LW", "RW", "LD", "RD", "G"]);
const SIDES = new Set(["home", "away"]);

function describe(p: PlayerContext): string {
  const bits: string[] = [];
  if (p.position && POSITIONS.has(p.position)) bits.push(p.position);
  if (typeof p.jerseyNumber === "number") bits.push(`#${p.jerseyNumber}`);
  if (p.indicatorColor?.trim()) bits.push(`${p.indicatorColor.trim().toLowerCase()} indicator`);
  if (p.teamSide && SIDES.has(p.teamSide)) bits.push(`${p.teamSide} side`);
  return bits.length ? bits.join(", ") : "the skater you control";
}

export class UserHintsControlledPlayerIdentifier implements ControlledPlayerIdentifier {
  readonly requiresFrames = true;

  async identify(input: {
    uploadId: string;
    ownerId: string;
    gameContext: GameContext;
    playerContext: PlayerContext;
    mediaMetadata: TrustedMediaMetadata;
    fixtureScenario?: FixtureScenario;
    frames?: ExtractedConfirmationFrame[];
  }): Promise<ControlledPlayerIdentificationResult> {
    const p = input.playerContext;
    const frames = input.frames ?? [];
    // Prefer a frame from the middle of the clip: past the faceoff, before the buzzer.
    const frame = frames[Math.floor(frames.length / 2)] ?? frames[0];
    const timestampSec = frame?.timestampSec ?? Math.min(1, input.mediaMetadata.durationSec);
    const position = p.position && POSITIONS.has(p.position) ? (p.position as ControlledPlayerIdentificationResult["position"]) : "unknown";
    const teamSide = p.teamSide && SIDES.has(p.teamSide) ? (p.teamSide as "home" | "away") : "unknown";
    const jerseyNumber = typeof p.jerseyNumber === "number" ? p.jerseyNumber : null;
    const indicatorColor = p.indicatorColor?.trim() ? p.indicatorColor.trim().toLowerCase().slice(0, 40) : null;
    const who = describe(p);

    return {
      provider: "user_hints",
      detected: false,
      confidence: USER_HINTS_CONFIDENCE,
      confidenceLabel: confidenceLabelFromScore(USER_HINTS_CONFIDENCE),
      position,
      jerseyNumber,
      indicatorColor,
      teamSide,
      evidenceTimestampsSec: [timestampSec],
      uncertainties: [
        "No visual identification was run on this clip; the candidate below is the skater you described on the upload screen.",
        "Confirm it on the frame — Scottie verifies the controlled skater in the gameplay frames during analysis.",
      ],
      confirmationRequired: true,
      candidates: [
        {
          displayLabel: `Your skater (${who})`,
          timestampSec,
          boundingBox: { ...CENTER_BOX },
          position,
          jerseyNumber,
          indicatorColor,
          teamSide,
          confidence: USER_HINTS_CONFIDENCE,
          evidenceSummary: `From your upload settings: ${who}. Look for the colored indicator under the skater on this frame and confirm.`,
        },
      ],
    };
  }
}
