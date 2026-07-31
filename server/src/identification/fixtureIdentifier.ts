/**
 * Deterministic controlled-player identification fixtures (dev/CI only).
 * Never labeled as Scotty output.
 */
import type { GameContext, PlayerContext, TrustedMediaMetadata } from "../scottyContract";
import {
  confidenceLabelFromScore,
  type PlayerIdentificationProvider,
} from "../scottyContract";

export type FixtureScenario =
  | "high_confidence_center"
  | "low_confidence_multiple_players"
  | "indicator_not_visible"
  | "jersey_number_conflict"
  | "candidate_none_correct"
  | "identification_failure"
  | "expired_upload";

export interface FixtureCandidateDraft {
  displayLabel: string;
  timestampSec: number;
  boundingBox: { x: number; y: number; width: number; height: number };
  position?: "C" | "LW" | "RW" | "LD" | "RD" | "G" | "unknown";
  jerseyNumber?: number | null;
  indicatorColor?: string | null;
  teamSide?: "home" | "away" | "unknown";
  confidence: number;
  evidenceSummary: string;
}

export interface ControlledPlayerIdentificationResult {
  provider: PlayerIdentificationProvider;
  fixtureScenario?: FixtureScenario;
  detected: boolean;
  confidence: number;
  confidenceLabel: ReturnType<typeof confidenceLabelFromScore>;
  position: "C" | "LW" | "RW" | "LD" | "RD" | "G" | "unknown";
  jerseyNumber: number | null;
  indicatorColor: string | null;
  teamSide: "home" | "away" | "unknown";
  evidenceTimestampsSec: number[];
  uncertainties: string[];
  confirmationRequired: boolean;
  failed?: boolean;
  errorMessage?: string;
  candidates: FixtureCandidateDraft[];
}

export interface ControlledPlayerIdentifier {
  identify(input: {
    uploadId: string;
    ownerId: string;
    gameContext: GameContext;
    playerContext: PlayerContext;
    mediaMetadata: TrustedMediaMetadata;
    fixtureScenario?: FixtureScenario;
  }): Promise<ControlledPlayerIdentificationResult>;
}

function scenarioFromEnvOrDefault(explicit?: FixtureScenario): FixtureScenario {
  if (explicit) return explicit;
  const env = process.env.CHELCOACH_PLAYER_ID_FIXTURE as FixtureScenario | undefined;
  if (env) return env;
  return "low_confidence_multiple_players";
}

export class FixtureControlledPlayerIdentifier implements ControlledPlayerIdentifier {
  async identify(input: {
    uploadId: string;
    ownerId: string;
    gameContext: GameContext;
    playerContext: PlayerContext;
    mediaMetadata: TrustedMediaMetadata;
    fixtureScenario?: FixtureScenario;
  }): Promise<ControlledPlayerIdentificationResult> {
    void input.ownerId;
    void input.gameContext;
    const scenario = scenarioFromEnvOrDefault(input.fixtureScenario);
    const duration = input.mediaMetadata.durationSec;
    const t1 = Math.min(11.8, Math.max(1, duration * 0.2));
    const t2 = Math.min(24.4, Math.max(2, duration * 0.45));
    const t3 = Math.min(41.0, Math.max(3, duration * 0.7));

    switch (scenario) {
      case "high_confidence_center": {
        const confidence = 0.93;
        return {
          provider: "fixture",
          fixtureScenario: scenario,
          detected: true,
          confidence,
          confidenceLabel: confidenceLabelFromScore(confidence),
          position: input.playerContext.position === "unknown" ? "C" : input.playerContext.position,
          jerseyNumber: input.playerContext.jerseyNumber ?? 17,
          indicatorColor: input.playerContext.indicatorColor ?? "blue",
          teamSide: input.playerContext.teamSide ?? "home",
          evidenceTimestampsSec: [t1],
          uncertainties: [],
          confirmationRequired: false,
          candidates: [],
        };
      }
      case "low_confidence_multiple_players":
      case "candidate_none_correct": {
        const confidence = 0.52;
        return {
          provider: "fixture",
          fixtureScenario: scenario,
          detected: true,
          confidence,
          confidenceLabel: confidenceLabelFromScore(confidence),
          position: "C",
          jerseyNumber: 17,
          indicatorColor: "blue",
          teamSide: "home",
          evidenceTimestampsSec: [t1, t2, t3],
          uncertainties: ["Multiple players match the provided context"],
          confirmationRequired: true,
          candidates: [
            {
              displayLabel: "Player 1",
              timestampSec: t1,
              boundingBox: { x: 0.32, y: 0.28, width: 0.18, height: 0.42 },
              position: "C",
              jerseyNumber: 17,
              indicatorColor: "blue",
              teamSide: "home",
              confidence: 0.52,
              evidenceSummary: "Blue indicator near center ice",
            },
            {
              displayLabel: "Player 2",
              timestampSec: t1,
              boundingBox: { x: 0.55, y: 0.3, width: 0.16, height: 0.4 },
              position: "RW",
              jerseyNumber: 88,
              indicatorColor: null,
              teamSide: "home",
              confidence: 0.41,
              evidenceSummary: "Nearby skater with visible jersey 88",
            },
            {
              displayLabel: "Player 3",
              timestampSec: t2,
              boundingBox: { x: 0.22, y: 0.35, width: 0.2, height: 0.38 },
              position: "LW",
              jerseyNumber: 19,
              indicatorColor: "blue",
              teamSide: "away",
              confidence: 0.38,
              evidenceSummary: "Similar indicator color on opposite side",
            },
            {
              displayLabel: "Player 4",
              timestampSec: t3,
              boundingBox: { x: 0.4, y: 0.25, width: 0.15, height: 0.45 },
              position: "C",
              jerseyNumber: null,
              indicatorColor: "blue",
              teamSide: "home",
              confidence: 0.35,
              evidenceSummary: "Indicator visible; jersey not readable",
            },
          ],
        };
      }
      case "indicator_not_visible": {
        const confidence = 0.28;
        return {
          provider: "fixture",
          fixtureScenario: scenario,
          detected: false,
          confidence,
          confidenceLabel: confidenceLabelFromScore(confidence),
          position: "unknown",
          jerseyNumber: null,
          indicatorColor: null,
          teamSide: "unknown",
          evidenceTimestampsSec: [t1, t2],
          uncertainties: ["No player indicator visible in representative frames"],
          confirmationRequired: true,
          candidates: [
            {
              displayLabel: "Player 1",
              timestampSec: t1,
              boundingBox: { x: 0.3, y: 0.3, width: 0.2, height: 0.4 },
              position: "C",
              jerseyNumber: 17,
              indicatorColor: null,
              teamSide: "home",
              confidence: 0.28,
              evidenceSummary: "Jersey 17 visible; indicator not visible",
            },
            {
              displayLabel: "Player 2",
              timestampSec: t2,
              boundingBox: { x: 0.5, y: 0.28, width: 0.18, height: 0.42 },
              position: "RW",
              jerseyNumber: 21,
              indicatorColor: null,
              teamSide: "home",
              confidence: 0.24,
              evidenceSummary: "Alternate home skater without indicator",
            },
          ],
        };
      }
      case "jersey_number_conflict": {
        const confidence = 0.48;
        return {
          provider: "fixture",
          fixtureScenario: scenario,
          detected: true,
          confidence,
          confidenceLabel: confidenceLabelFromScore(confidence),
          position: "C",
          jerseyNumber: 17,
          indicatorColor: "blue",
          teamSide: "home",
          evidenceTimestampsSec: [t1, t2],
          uncertainties: ["Conflicting jersey number evidence across frames"],
          confirmationRequired: true,
          candidates: [
            {
              displayLabel: "Player 1",
              timestampSec: t1,
              boundingBox: { x: 0.35, y: 0.3, width: 0.17, height: 0.4 },
              position: "C",
              jerseyNumber: 17,
              indicatorColor: "blue",
              teamSide: "home",
              confidence: 0.48,
              evidenceSummary: "Jersey reads 17 with blue indicator",
            },
            {
              displayLabel: "Player 2",
              timestampSec: t2,
              boundingBox: { x: 0.35, y: 0.3, width: 0.17, height: 0.4 },
              position: "C",
              jerseyNumber: 71,
              indicatorColor: "blue",
              teamSide: "home",
              confidence: 0.44,
              evidenceSummary: "Same track later reads jersey 71",
            },
          ],
        };
      }
      case "identification_failure":
        return {
          provider: "fixture",
          fixtureScenario: scenario,
          detected: false,
          confidence: 0,
          confidenceLabel: "insufficient",
          position: "unknown",
          jerseyNumber: null,
          indicatorColor: null,
          teamSide: "unknown",
          evidenceTimestampsSec: [],
          uncertainties: ["Identification failed"],
          confirmationRequired: false,
          failed: true,
          errorMessage: "Fixture identification failure",
          candidates: [],
        };
      case "expired_upload":
        return {
          provider: "fixture",
          fixtureScenario: scenario,
          detected: false,
          confidence: 0,
          confidenceLabel: "insufficient",
          position: "unknown",
          jerseyNumber: null,
          indicatorColor: null,
          teamSide: "unknown",
          evidenceTimestampsSec: [],
          uncertainties: ["Upload expired"],
          confirmationRequired: false,
          failed: true,
          errorMessage: "Upload expired",
          candidates: [],
        };
      default:
        return this.identify({ ...input, fixtureScenario: "low_confidence_multiple_players" });
    }
  }
}

let identifier: ControlledPlayerIdentifier = new FixtureControlledPlayerIdentifier();

export function getControlledPlayerIdentifier(): ControlledPlayerIdentifier {
  return identifier;
}

export function setControlledPlayerIdentifierForTests(
  next: ControlledPlayerIdentifier | undefined,
): void {
  identifier = next ?? new FixtureControlledPlayerIdentifier();
}
