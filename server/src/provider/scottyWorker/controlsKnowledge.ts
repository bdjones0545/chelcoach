/**
 * Control-input knowledge for coaching reports.
 *
 * The model recommends mechanics by id only; the application attaches the button inputs from
 * this table, so a report never carries a model-invented control. Entries are marked `verified`
 * only where the default EA NHL Skill Stick mapping is stable across recent titles; everything
 * else is `provisional` and the report says so. Xbox and PlayStation inputs are never mixed
 * inside one guidance object (the contract rejects that).
 */
import type { ControlGuidance, ControlInputStep } from "../../scottyContract";

export const CONTROL_KNOWLEDGE_VERSION = "controls-2026-09-v1";
export const STRATEGY_KNOWLEDGE_VERSION = "strategy-2026-09-v1";
export const RUBRIC_VERSION = "chelcoach-rubric-v1";
export const REPORT_VERSION = "scotty-worker-report-v1";

export type PadFamily = "xbox" | "playstation";

interface MechanicDefinition {
  id: string;
  label: string;
  /** Steps per pad family; a mechanic with no entry for a family gets the other family's layout marked provisional. */
  inputs: Record<PadFamily, ControlInputStep[]>;
  timingCue?: string;
  verified: boolean;
}

const M = (
  id: string,
  label: string,
  xbox: Array<[string, ControlInputStep["behavior"], string?]>,
  playstation: Array<[string, ControlInputStep["behavior"], string?]>,
  verified: boolean,
  timingCue?: string,
): MechanicDefinition => ({
  id,
  label,
  verified,
  timingCue,
  inputs: {
    xbox: xbox.map(([input, behavior, note], order) => ({ order, input, behavior, ...(note ? { note } : {}) })),
    playstation: playstation.map(([input, behavior, note], order) => ({ order, input, behavior, ...(note ? { note } : {}) })),
  },
});

/** Skill Stick (default) mechanics. */
const MECHANICS: MechanicDefinition[] = [
  M("skate_control", "Skating and body position", [["LS", "motion", "Steer the skater"]], [["LS", "motion", "Steer the skater"]], true),
  M("vision_control", "Vision control (face the play / skate backward)", [["LT", "hold"]], [["L2", "hold"]], true, "Hold while retreating so you keep eyes on the puck carrier"),
  M("pass", "Pass", [["RT", "hold", "Hold longer for a harder pass"]], [["R2", "hold", "Hold longer for a harder pass"]], true, "Release as the lane opens, not after"),
  M("saucer_pass", "Saucer pass", [["RB", "tap"]], [["R1", "tap"]], true, "Use when a stick or body is in the passing lane"),
  M("wrist_shot", "Wrist shot", [["RS", "motion", "Pull back, then flick up toward the net"]], [["RS", "motion", "Pull back, then flick up toward the net"]], true, "Shoot as the goalie is moving laterally"),
  M("slap_shot", "Slap shot", [["RS", "motion", "Pull fully back, then push up"]], [["RS", "motion", "Pull fully back, then push up"]], true, "Only with time and space; the wind-up is slow"),
  M("one_timer", "One-timer", [["RS", "motion", "Flick up as the pass arrives"]], [["RS", "motion", "Flick up as the pass arrives"]], true, "Start the shot motion just before the puck reaches the blade"),
  M("deke", "Skill stick deke", [["RS", "motion", "Move the puck side to side"]], [["RS", "motion", "Move the puck side to side"]], true),
  M("protect_puck", "Protect the puck", [["LB", "hold"]], [["L1", "hold"]], true, "Hold when a defender closes from behind or along the boards"),
  M("poke_check", "Poke check", [["RB", "tap"]], [["R1", "tap"]], true, "Reach when the puck is exposed, not at the skater's body"),
  M("stick_lift", "Stick lift", [["RT", "tap"]], [["R2", "tap"]], true, "Lift as the carrier receives the puck"),
  M("body_check", "Body check", [["RS", "motion", "Push toward the carrier"]], [["RS", "motion", "Push toward the carrier"]], true, "Line up the shoulder first; late hits leave you out of position"),
  M("hustle", "Hustle / speed burst", [["L3", "tap", "Click the left stick"]], [["L3", "tap", "Click the left stick"]], false),
  M("gap_control", "Gap control (defensive angling)", [["LS", "motion", "Match the carrier's speed"], ["LT", "hold", "Face the puck"]], [["LS", "motion", "Match the carrier's speed"], ["L2", "hold", "Face the puck"]], true, "Close the gap through the neutral zone, then hold your line at the blue line"),
  M("faceoff_backhand", "Faceoff: backhand win", [["RS", "motion", "Pull back on the drop"]], [["RS", "motion", "Pull back on the drop"]], false, "Move on the puck drop, not on the referee's hand"),
  M("faceoff_forehand", "Faceoff: forehand win", [["RS", "motion", "Push forward on the drop"]], [["RS", "motion", "Push forward on the drop"]], false),
  M("faceoff_tie_up", "Faceoff: tie up", [["LB", "hold", "Tie up the opposing center"]], [["L1", "hold", "Tie up the opposing center"]], false, "Use when losing draws clean; a winger collects the puck"),
  M("board_pin", "Board pin / battle", [["RS", "motion", "Push into the carrier along the boards"]], [["RS", "motion", "Push into the carrier along the boards"]], false),
  M("shot_block", "Shot block", [["Y", "hold"]], [["Triangle", "hold"]], false, "Drop only when the shooter is committed"),
  M("goalie_butterfly", "Goalie: butterfly", [["RT", "hold"]], [["R2", "hold"]], false),
];

const BY_ID = new Map(MECHANICS.map((m) => [m.id, m]));

export function mechanicIds(): string[] {
  return MECHANICS.map((m) => m.id);
}

export function padFamilyForPlatform(platform: string): PadFamily {
  return platform.toLowerCase().startsWith("playstation") ? "playstation" : "xbox";
}

export function isKnownMechanic(id: string | null | undefined): id is string {
  return Boolean(id && BY_ID.has(id));
}

export function mechanicLabel(id: string): string {
  return BY_ID.get(id)?.label ?? id;
}

/**
 * Build contract-shaped control guidance for a mechanic on the user's platform and scheme.
 * Schemes other than Skill Stick reuse the same layout but are always marked provisional —
 * the default Total Control / Hybrid maps differ and are not verified here.
 */
export function controlGuidanceFor(input: {
  mechanicId: string;
  gameTitle: string;
  gameVersion?: string;
  platform: string;
  controlScheme: string;
  verifiedAt: string;
}): ControlGuidance | null {
  const def = BY_ID.get(input.mechanicId);
  if (!def) return null;
  const family = padFamilyForPlatform(input.platform);
  const steps = def.inputs[family];
  if (!steps.length) return null;
  const verified = def.verified && input.controlScheme === "skill_stick";
  return {
    gameTitle: input.gameTitle,
    ...(input.gameVersion ? { gameVersion: input.gameVersion } : {}),
    platform: input.platform as ControlGuidance["platform"],
    controlScheme: input.controlScheme as ControlGuidance["controlScheme"],
    canonicalMechanic: def.id,
    inputSequence: steps.map((s) => ({ ...s })),
    ...(def.timingCue ? { timingCue: def.timingCue } : {}),
    verificationStatus: verified ? "verified" : "provisional",
    ...(verified ? { verifiedAt: input.verifiedAt } : {}),
    sourceConfidence: verified ? "high" : "moderate",
    platformComparison: false,
  };
}

/** Input steps for a set of mechanics, renumbered and capped for a practice drill. */
export function drillInputsFor(mechanicIdsForDrill: string[], platform: string, max = 40): ControlInputStep[] {
  const family = padFamilyForPlatform(platform);
  const out: ControlInputStep[] = [];
  for (const id of mechanicIdsForDrill) {
    const def = BY_ID.get(id);
    if (!def) continue;
    for (const step of def.inputs[family]) {
      if (out.length >= max) return out;
      out.push({ ...step, order: out.length, note: step.note ?? def.label });
    }
  }
  return out;
}
