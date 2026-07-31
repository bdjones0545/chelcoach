import type { MediaClassification } from "../../scottyContract";

export const SIMULATOR_SCENARIOS = [
  "successful_short_clip",
  "successful_full_game",
  "successful_extended_clip",
  "player_confirmation_required",
  "provider_timeout",
  "provider_failure_during_inspection",
  "provider_failure_during_analysis",
  "report_validation_failure",
  "cancel_before_analysis",
  "cancel_during_analysis",
  "duplicate_submission",
  "slow_full_game",
  "unsupported_contract_response",
  "stalled_job",
] as const;

export type SimulatorScenario = (typeof SIMULATOR_SCENARIOS)[number];

export type FailurePoint =
  | "submission"
  | "inspecting_input"
  | "extracting_frames"
  | "identifying_controlled_player"
  | "analyzing_gameplay"
  | "validating_report"
  | "finalizing"
  | null;

export function isSimulatorScenario(value: string): value is SimulatorScenario {
  return (SIMULATOR_SCENARIOS as readonly string[]).includes(value);
}

/** Process-wide E2E override — never set outside CHELCOACH_E2E_MODE hooks. */
let e2eScenarioOverride: SimulatorScenario | null = null;

export function setE2eSimulatorScenarioOverride(scenario: SimulatorScenario | null): void {
  e2eScenarioOverride = scenario;
}

export function getE2eSimulatorScenarioOverride(): SimulatorScenario | null {
  return e2eScenarioOverride;
}

export function resolveSimulatorScenario(input: {
  injected?: SimulatorScenario;
  envDefault?: string;
  mediaClassification: MediaClassification;
}): SimulatorScenario {
  if (input.injected) return input.injected;
  if (e2eScenarioOverride) return e2eScenarioOverride;
  const env = (input.envDefault ?? process.env.SCOTTY_SIMULATOR_DEFAULT_SCENARIO ?? "auto").trim();
  if (env !== "auto" && isSimulatorScenario(env)) return env;
  if (input.mediaClassification === "full_game") return "successful_full_game";
  if (input.mediaClassification === "extended_clip") return "successful_extended_clip";
  return "successful_short_clip";
}

export function failurePointForScenario(scenario: SimulatorScenario): FailurePoint {
  switch (scenario) {
    case "provider_failure_during_inspection":
      return "inspecting_input";
    case "provider_failure_during_analysis":
      return "analyzing_gameplay";
    case "report_validation_failure":
      return "validating_report";
    case "provider_timeout":
      return "finalizing";
    default:
      return null;
  }
}

export function requiresRemoteConfirmation(scenario: SimulatorScenario): boolean {
  return scenario === "player_confirmation_required";
}

export function isSlowFullGame(scenario: SimulatorScenario): boolean {
  return scenario === "slow_full_game" || scenario === "successful_full_game";
}
