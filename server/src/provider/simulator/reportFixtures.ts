/**
 * Named deterministic report fixture IDs for the local simulator.
 * Reports are built by `buildSimulatorReport` and labeled here for tests/docs.
 */
export const SIMULATOR_REPORT_FIXTURES = [
  "short_clip_success_report",
  "extended_clip_success_report",
  "full_game_success_report",
  "faceoff_heavy_report",
  "strategy_heavy_report",
  "playstation_total_control_report",
  "xbox_skill_stick_report",
] as const;

export type SimulatorReportFixtureId = (typeof SIMULATOR_REPORT_FIXTURES)[number];

export function resolveReportFixtureId(input: {
  mediaClassification: string;
  platform: string;
  controlScheme: string;
  includeFaceoffs: boolean;
  strategyHeavy?: boolean;
}): SimulatorReportFixtureId {
  if (input.platform.startsWith("playstation") && input.controlScheme === "total_control") {
    return "playstation_total_control_report";
  }
  if (input.platform.startsWith("xbox") && input.controlScheme === "skill_stick") {
    return "xbox_skill_stick_report";
  }
  if (input.includeFaceoffs && input.mediaClassification === "full_game") {
    return "faceoff_heavy_report";
  }
  if (input.strategyHeavy) return "strategy_heavy_report";
  if (input.mediaClassification === "full_game") return "full_game_success_report";
  if (input.mediaClassification === "extended_clip") return "extended_clip_success_report";
  return "short_clip_success_report";
}
