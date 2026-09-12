/**
 * The one place ChelCoach talks to a vision model.
 *
 * Two operations, both over sampled JPEG frames: locate the user's controlled skater, and
 * produce a coaching analysis. Application services never import the Anthropic SDK; they depend
 * on `VisionModelClient`, which tests replace with a fake. Model output is constrained to the
 * schemas below (structured outputs) and then re-validated by the caller against the report
 * contract — the model never writes the report directly.
 */
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
// The SDK's structured-output helper is typed against Zod 4; the report contract stays on the
// Zod 3 API, so these model-facing schemas are built with the v4 entry point deliberately.
import { z } from "zod/v4";
import { ProviderError } from "../provider/errors";
import type { GameContext, PlayerContext } from "../scottyContract";
import { ANALYSIS_SYSTEM_PROMPT, IDENTIFICATION_SYSTEM_PROMPT, buildAnalysisTask, buildIdentificationTask } from "./prompts";

export const DEFAULT_VISION_MODEL = "claude-opus-5";

export interface ModelFrame {
  /** Position in the frame list — the model refers to frames by this index. */
  index: number;
  timestampSec: number;
  jpegBase64: string;
}

/* ------------------------------------------------------------------------------------------ */
/* Model-facing schemas. Keep to the structured-output subset (objects, arrays, enums, strings, */
/* numbers, booleans, nullable) — bounds are enforced afterwards by the application.           */
/* ------------------------------------------------------------------------------------------ */

const positionEnum = z.enum(["C", "LW", "RW", "LD", "RD", "G", "unknown"]);
const teamSideEnum = z.enum(["home", "away", "unknown"]);
const confidenceEnum = z.enum(["very_high", "high", "moderate", "low", "insufficient"]);

export const identificationModelOutputSchema = z.object({
  /** True when a skater matching the user's context is visible with an indicator. */
  detected: z.boolean(),
  /** 0–1. Below the confirmation threshold the user will be asked to confirm. */
  confidence: z.number(),
  predicted: z.object({
    position: positionEnum,
    jerseyNumber: z.number().nullable(),
    indicatorColor: z.string().nullable(),
    teamSide: teamSideEnum,
  }),
  uncertainties: z.array(z.string()),
  candidates: z.array(
    z.object({
      frameIndex: z.number(),
      displayLabel: z.string(),
      /** Normalized 0–1 box around the skater, relative to the full frame. */
      boundingBox: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }),
      position: positionEnum,
      jerseyNumber: z.number().nullable(),
      indicatorColor: z.string().nullable(),
      teamSide: teamSideEnum,
      confidence: z.number(),
      evidenceSummary: z.string(),
    }),
  ),
});
export type IdentificationModelOutput = z.infer<typeof identificationModelOutputSchema>;

export const observationCategoryEnum = z.enum([
  "positioning",
  "decision_making",
  "puck_management",
  "defense",
  "offense",
  "transition",
  "faceoff",
  "special_teams",
  "other",
]);

export const strategyCategoryEnum = z.enum([
  "forecheck",
  "neutral_zone",
  "defensive_zone",
  "power_play",
  "penalty_kill",
  "breakout",
  "cycle",
  "transition",
  "unknown",
  "insufficient_evidence",
]);

export const gameplayAnalysisModelOutputSchema = z.object({
  controlledPlayerConfidence: confidenceEnum,
  observations: z.array(
    z.object({
      frameIndex: z.number(),
      category: observationCategoryEnum,
      observedAction: z.string(),
      attributionExplanation: z.string(),
      coachingInterpretation: z.string(),
      confidence: confidenceEnum,
      /** A mechanic id from the provided list, or null. */
      recommendedMechanic: z.string().nullable(),
    }),
  ),
  strengths: z.array(z.string()),
  priorityImprovements: z.array(z.string()),
  strategyAnalysis: z.object({
    observedStrategy: z.string(),
    strategyCategory: strategyCategoryEnum,
    playerResponsibility: z.string(),
    executionAssessment: z.string(),
    strategicStrengths: z.array(z.string()),
    strategicImprovements: z.array(z.string()),
    recommendedAdjustment: z.string().nullable(),
    knownCounters: z.array(z.string()),
    /** Mechanic ids from the provided list. */
    requiredMechanics: z.array(z.string()),
    confidence: confidenceEnum,
    supportingFrameIndices: z.array(z.number()),
  }),
  /** Null when no faceoff is visible in the sampled frames. */
  faceoffAnalysis: z
    .object({
      faceoffCount: z.number(),
      wins: z.number(),
      losses: z.number(),
      detectedTechniques: z.array(z.string()),
      timingAssessment: z.string().nullable(),
      counterSelection: z.string().nullable(),
      postDrawResponsibility: z.string().nullable(),
      possessionResult: z.string().nullable(),
      strengths: z.array(z.string()),
      improvements: z.array(z.string()),
      confidence: confidenceEnum,
    })
    .nullable(),
  practiceDrills: z.array(
    z.object({
      name: z.string(),
      objective: z.string(),
      setup: z.string(),
      /** Mechanic ids from the provided list. */
      requiredMechanics: z.array(z.string()),
      repetitionTarget: z.string(),
      successCriteria: z.string(),
      commonErrors: z.array(z.string()),
      progression: z.string().nullable(),
    }),
  ),
  uncertaintyDisclosures: z.array(z.string()),
});
export type GameplayAnalysisModelOutput = z.infer<typeof gameplayAnalysisModelOutputSchema>;

export interface IdentificationPromptContext {
  gameContext: GameContext;
  playerContext: PlayerContext;
  durationSec: number;
}

export interface AnalysisPromptContext {
  gameContext: GameContext;
  playerContext: PlayerContext;
  effectivePlayer: {
    position: string;
    jerseyNumber: number | null;
    indicatorColor: string | null;
    teamSide: string;
    userConfirmed: boolean;
  };
  durationSec: number;
  mediaClassification: string;
  /** Mechanic ids the model may reference; anything else is dropped at assembly. */
  mechanicIds: string[];
}

export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
  model: string;
}

export interface VisionModelClient {
  readonly configured: boolean;
  identifyControlledPlayer(input: {
    frames: ModelFrame[];
    context: IdentificationPromptContext;
  }): Promise<{ output: IdentificationModelOutput; usage: ModelUsage }>;
  analyzeGameplay(input: {
    frames: ModelFrame[];
    context: AnalysisPromptContext;
  }): Promise<{ output: GameplayAnalysisModelOutput; usage: ModelUsage }>;
}

export function isVisionModelConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  const key = (env.ANTHROPIC_API_KEY ?? "").trim();
  return key.length > 20;
}

export function visionModelId(env: NodeJS.ProcessEnv = process.env): string {
  return (env.CHELCOACH_ANALYSIS_MODEL ?? "").trim() || DEFAULT_VISION_MODEL;
}

function frameBlocks(frames: ModelFrame[]): Anthropic.ContentBlockParam[] {
  return frames.flatMap<Anthropic.ContentBlockParam>((f) => [
    { type: "text", text: `Frame ${f.index} — ${f.timestampSec.toFixed(1)}s into the clip` },
    { type: "image", source: { type: "base64", media_type: "image/jpeg", data: f.jpegBase64 } },
  ]);
}

function mapSdkError(err: unknown, requestId?: string): ProviderError {
  const base = { provider: "scotty_worker" as const, requestId };
  if (err instanceof ProviderError) return err;
  if (err instanceof Anthropic.AuthenticationError) {
    return new ProviderError("PROVIDER_MISCONFIGURED", "Vision model credentials rejected.", "configuration", {
      ...base,
      retryable: false,
      cause: err,
    });
  }
  if (err instanceof Anthropic.RateLimitError) {
    return new ProviderError("RATE_LIMITED", "Vision model rate limited.", "rate_limit", {
      ...base,
      retryable: true,
      cause: err,
    });
  }
  if (err instanceof Anthropic.BadRequestError) {
    return new ProviderError("ANALYSIS_FAILED", "Vision model rejected the request.", "validation", {
      ...base,
      retryable: false,
      cause: err,
    });
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return new ProviderError("PROVIDER_UNAVAILABLE", "Vision model unreachable.", "network", {
      ...base,
      retryable: true,
      cause: err,
    });
  }
  if (err instanceof Anthropic.APIError) {
    const retryable = (err.status ?? 500) >= 500 || err.status === 408 || err.status === 409;
    return new ProviderError(
      retryable ? "PROVIDER_UNAVAILABLE" : "ANALYSIS_FAILED",
      `Vision model error (${err.status ?? "unknown"}).`,
      retryable ? "provider_unavailable" : "permanent_failure",
      { ...base, retryable, httpStatus: err.status, cause: err },
    );
  }
  return new ProviderError("ANALYSIS_FAILED", "Vision model call failed.", "permanent_failure", {
    ...base,
    retryable: false,
    cause: err,
  });
}

/**
 * Anthropic-backed implementation. Structured outputs guarantee the shape; the caller still
 * applies every bound from the report contract before anything is persisted.
 */
export class AnthropicVisionModelClient implements VisionModelClient {
  readonly configured: boolean;
  private client: Anthropic | null = null;
  private readonly model: string;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.configured = isVisionModelConfigured(env);
    this.model = visionModelId(env);
  }

  private sdk(): Anthropic {
    if (!this.configured) {
      throw new ProviderError("PROVIDER_MISCONFIGURED", "ANTHROPIC_API_KEY is not configured.", "configuration", {
        provider: "scotty_worker",
        retryable: false,
      });
    }
    if (!this.client) {
      // Frames make requests large; the SDK timeout is milliseconds.
      this.client = new Anthropic({ timeout: 240_000, maxRetries: 2 });
    }
    return this.client;
  }

  private async parse<T extends z.ZodType>(input: {
    system: string;
    frames: ModelFrame[];
    task: string;
    schema: T;
    requestId?: string;
  }): Promise<{ output: z.infer<T>; usage: ModelUsage }> {
    let response: Awaited<ReturnType<Anthropic["messages"]["parse"]>>;
    try {
      response = await this.sdk().messages.parse({
        model: this.model,
        max_tokens: 16000,
        system: [{ type: "text", text: input.system, cache_control: { type: "ephemeral" } }],
        messages: [{ role: "user", content: [...frameBlocks(input.frames), { type: "text", text: input.task }] }],
        output_config: { format: zodOutputFormat(input.schema) },
      });
    } catch (err) {
      throw mapSdkError(err, input.requestId);
    }
    if (response.stop_reason === "refusal") {
      throw new ProviderError(
        "ANALYSIS_FAILED",
        "The vision model declined to analyze this footage.",
        "permanent_failure",
        { provider: "scotty_worker", retryable: false, requestId: input.requestId },
      );
    }
    if (response.stop_reason === "max_tokens") {
      throw new ProviderError("ANALYSIS_FAILED", "Vision model output was truncated.", "invalid_response", {
        provider: "scotty_worker",
        retryable: true,
        requestId: input.requestId,
      });
    }
    const parsed = response.parsed_output;
    if (!parsed) {
      throw new ProviderError("REPORT_VALIDATION_FAILED", "Vision model output did not match the schema.", "invalid_response", {
        provider: "scotty_worker",
        retryable: true,
        requestId: input.requestId,
      });
    }
    return {
      output: parsed as z.infer<T>,
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        model: response.model,
      },
    };
  }

  identifyControlledPlayer(input: { frames: ModelFrame[]; context: IdentificationPromptContext }) {
    return this.parse({
      system: IDENTIFICATION_SYSTEM_PROMPT,
      frames: input.frames,
      task: buildIdentificationTask(input.context, input.frames.length),
      schema: identificationModelOutputSchema,
    });
  }

  analyzeGameplay(input: { frames: ModelFrame[]; context: AnalysisPromptContext }) {
    return this.parse({
      system: ANALYSIS_SYSTEM_PROMPT,
      frames: input.frames,
      task: buildAnalysisTask(input.context, input.frames.length),
      schema: gameplayAnalysisModelOutputSchema,
    });
  }
}

let client: VisionModelClient | null = null;

export function getVisionModelClient(): VisionModelClient {
  if (!client) client = new AnthropicVisionModelClient();
  return client;
}

export function setVisionModelClientForTests(next: VisionModelClient | null): void {
  client = next;
}
