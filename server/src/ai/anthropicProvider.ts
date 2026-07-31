/**
 * Anthropic Messages API provider — vision + structured JSON output.
 *
 * Official docs verified (2026):
 * - Models: https://docs.anthropic.com/en/docs/about-claude/models/overview
 * - Vision: https://platform.claude.com/docs/en/build-with-claude/vision
 * - Structured outputs: https://platform.claude.com/docs/en/build-with-claude/structured-outputs
 *
 * Default model: claude-sonnet-5 (vision + structured outputs).
 * Does not log API keys, image payloads, or complete provider responses.
 */
import Anthropic from "@anthropic-ai/sdk";
import { aiConfig, readApiKeyFromEnv } from "./config";
import { AiAnalysisError } from "./errors";
import type { AiAnalysisInput } from "./input";
import { buildSystemPrompt, buildUserText } from "./prompt";
import type { AiProviderResult, GameplayAnalysisProvider } from "./provider";
import { analysisReportJsonSchema } from "./reportSchema";

function mapAnthropicError(err: unknown): AiAnalysisError {
  if (err instanceof AiAnalysisError) return err;
  if (err instanceof Error && err.name === "AbortError") {
    return new AiAnalysisError("AI_ABORTED", "aborted", { retryable: false });
  }

  // SDK errors expose status / type without dumping bodies into our messages.
  const status =
    typeof err === "object" && err !== null && "status" in err
      ? Number((err as { status?: number }).status)
      : undefined;
  const type =
    typeof err === "object" && err !== null && "error" in err
      ? String((err as { error?: { type?: string } }).error?.type ?? "")
      : "";
  const message = err instanceof Error ? err.message : "provider error";

  if (status === 401 || status === 403 || type.includes("authentication")) {
    return new AiAnalysisError("AI_AUTHENTICATION_FAILED", message, { retryable: false });
  }
  if (status === 429 || type.includes("rate_limit")) {
    return new AiAnalysisError("AI_RATE_LIMITED", message, { retryable: true });
  }
  if (status === 413 || /too large|request_too_large/i.test(message)) {
    return new AiAnalysisError("AI_REQUEST_TOO_LARGE", message, { retryable: false });
  }
  if (status === 400 && /content|image|media|unsupported/i.test(message)) {
    return new AiAnalysisError("AI_CONTENT_UNSUPPORTED", message, { retryable: false });
  }
  if (status === 408 || /timeout|timed out/i.test(message)) {
    return new AiAnalysisError("AI_REQUEST_TIMEOUT", message, { retryable: true });
  }
  if (status === 529 || status === 503 || status === 502) {
    return new AiAnalysisError("AI_PROVIDER_UNAVAILABLE", message, { retryable: true });
  }
  if (/refus/i.test(message)) {
    return new AiAnalysisError("AI_RESPONSE_REFUSED", message, { retryable: false });
  }
  return new AiAnalysisError("AI_PROVIDER_UNAVAILABLE", message, { retryable: true });
}

export class AnthropicGameplayAnalysisProvider implements GameplayAnalysisProvider {
  readonly name = "anthropic";

  async analyzeGameplay(input: AiAnalysisInput, signal: AbortSignal): Promise<AiProviderResult> {
    const apiKey = readApiKeyFromEnv() || aiConfig.apiKey;
    if (!apiKey) {
      throw new AiAnalysisError("AI_NOT_CONFIGURED", "missing ANTHROPIC_API_KEY", {
        retryable: false,
      });
    }

    const client = new Anthropic({
      apiKey,
      timeout: aiConfig.requestTimeoutMs,
      maxRetries: 0, // we own retry policy
    });

    const content: Anthropic.MessageCreateParams["messages"][0]["content"] = [];

    // Images before text (Anthropic vision guidance).
    for (const frame of input.frames) {
      content.push({
        type: "text",
        text: `Frame ${frame.index + 1} @ ${frame.timestampSec.toFixed(3)}s`,
      });
      content.push({
        type: "image",
        source: {
          type: "base64",
          media_type: "image/jpeg",
          data: frame.bytes.toString("base64"),
        },
      });
    }

    content.push({
      type: "text",
      text: buildUserText({
        clipId: input.clipId,
        durationSec: input.durationSec,
        width: input.width,
        height: input.height,
        fps: input.fps,
        timestampsSec: input.timestampsSec,
        frameCount: input.frames.length,
        contextualHints: input.contextualHints,
      }),
    });

    // Bound base64 lifetime: local vars only; buffers released by caller after return.
    try {
      const response = await client.messages.create(
        {
          model: aiConfig.model,
          max_tokens: aiConfig.maxOutputTokens,
          system: buildSystemPrompt(),
          messages: [{ role: "user", content }],
          stream: false,
          output_config: {
            format: {
              type: "json_schema",
              schema: analysisReportJsonSchema,
            },
          },
        },
        { signal },
      );

      if (response.stop_reason === "refusal") {
        throw new AiAnalysisError("AI_RESPONSE_REFUSED", "model refusal", { retryable: false });
      }

      const textBlock = response.content.find((b: { type: string }) => b.type === "text");
      if (!textBlock || textBlock.type !== "text" || !("text" in textBlock) || !textBlock.text) {
        throw new AiAnalysisError("AI_RESPONSE_INVALID", "empty response", { retryable: false });
      }

      let raw: unknown;
      try {
        raw = JSON.parse(textBlock.text);
      } catch {
        throw new AiAnalysisError("AI_RESPONSE_INVALID", "non-json response", {
          retryable: false,
        });
      }

      console.log(
        `[chelcoach-api] anthropic ok model=${response.model} in=${response.usage?.input_tokens ?? "?"} out=${response.usage?.output_tokens ?? "?"} frames=${input.frames.length}`,
      );

      return {
        raw,
        provider: this.name,
        model: response.model,
        usage: {
          inputTokens: response.usage?.input_tokens,
          outputTokens: response.usage?.output_tokens,
        },
      };
    } catch (err) {
      if (err instanceof AiAnalysisError) throw err;
      throw mapAnthropicError(err);
    }
  }
}
