/**
 * ChelCoach ↔ Scotty shared contracts (Zod schemas + inferred types).
 * Single source of truth for frontend, backend, simulator, and gateway.
 */
export * from "./version";
export * from "./enums";
export * from "./errors";
export * from "./retention";
export * from "./player-context";
export * from "./game-context";
export * from "./upload";
export * from "./lease";
export * from "./analysis-request";
export * from "./job";
export * from "./player-identification";
export * from "./confirmation";
export * from "./controls";
export * from "./strategies";
export * from "./faceoffs";
export * from "./drills";
export * from "./report";
export * from "./profile";
export * from "./media-classification";
export * from "./games";
export * from "./upload-context";
export {
  FIXED_NOW,
  xboxPlayerContext,
  playstationPlayerContext,
  sampleGameContext,
  trustedMedia,
  xboxControlGuidance,
  minimalScottyReport,
} from "./fixtures";
