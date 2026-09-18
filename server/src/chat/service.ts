/**
 * "Ask Scottie" — chat about one completed coaching report.
 *
 * Ownership and readiness come from getAnalysisReport(): only the owner, only once the report
 * exists. The provider is stateless; ChelCoach keeps the turns (chat/repository.ts) and sends the
 * report plus the recent turns on every call. Every user turn is a paid model call, so a durable
 * per-user daily cap is enforced here, not in the per-instance rate bucket.
 */
import { getChelCoachConfig } from "../config/chelcoachConfig";
import { ProviderError } from "../provider/errors";
import { getScottyProvider } from "../provider/factory";
import { getAnalysisReport } from "../provider/statusService";
import type { ScottyReport } from "../scottyContract";
import { getChatRepository, type ChatMessageRecord } from "./repository";

export const MAX_CHAT_MESSAGE_CHARS = 1_500;
/** Turns sent to the provider as context (oldest dropped first). */
export const CHAT_CONTEXT_TURNS = 12;
/** Turns returned to the UI. */
export const CHAT_HISTORY_LIMIT = 100;

export class ChatServiceError extends Error {
  constructor(
    public httpStatus: number,
    public code: string,
    message: string,
    public retryable = false,
  ) {
    super(message);
  }
}

export type PublicChatMessage = Pick<ChatMessageRecord, "id" | "role" | "content" | "createdAt">;

function toPublic(m: ChatMessageRecord): PublicChatMessage {
  return { id: m.id, role: m.role, content: m.content, createdAt: m.createdAt };
}

/**
 * What Scottie is allowed to talk about: the report, trimmed to what a coach would re-read.
 * No storage keys, no ids, no media URLs — none of those are in the contract report anyway, but
 * this keeps the boundary explicit and the payload bounded.
 */
export function buildReportContext(report: ScottyReport): Record<string, unknown> {
  return {
    gameContext: report.gameContext,
    playerAttribution: {
      position: report.playerAttribution.position,
      jerseyNumber: report.playerAttribution.jerseyNumber,
      indicatorColor: report.playerAttribution.indicatorColor,
      confirmationState: report.playerAttribution.confirmationState,
    },
    controlledPlayerConfidence: report.controlledPlayerConfidence,
    ...(report.performanceEstimate ? { performanceEstimate: report.performanceEstimate } : {}),
    playerSpecificObservations: report.playerSpecificObservations.slice(0, 40),
    strengths: report.strengths,
    priorityImprovements: report.priorityImprovements,
    strategyAnalysis: report.strategyAnalysis,
    ...(report.faceoffAnalysis ? { faceoffAnalysis: report.faceoffAnalysis } : {}),
    controlGuidance: report.controlGuidance,
    practiceDrills: report.practiceDrills,
    uncertaintyDisclosures: report.uncertaintyDisclosures,
    rubricVersion: report.rubricVersion,
  };
}

export async function listChat(input: { ownerId: string; applicationRequestId: string }): Promise<PublicChatMessage[]> {
  // Ownership + "report exists" gate; throws AnalysisStatusError otherwise.
  await getAnalysisReport(input);
  const rows = await getChatRepository().listByRequest(input.applicationRequestId, CHAT_HISTORY_LIMIT);
  return rows.map(toPublic);
}

export async function sendChat(input: {
  ownerId: string;
  applicationRequestId: string;
  message: unknown;
}): Promise<{ reply: PublicChatMessage; messages: PublicChatMessage[] }> {
  const content = typeof input.message === "string" ? input.message.replace(/\s+/g, " ").trim() : "";
  if (!content) throw new ChatServiceError(400, "INVALID_REQUEST", "Write a question first.");
  if (content.length > MAX_CHAT_MESSAGE_CHARS) {
    throw new ChatServiceError(400, "INVALID_REQUEST", `Keep it under ${MAX_CHAT_MESSAGE_CHARS} characters.`);
  }

  const envelope = await getAnalysisReport({ ownerId: input.ownerId, applicationRequestId: input.applicationRequestId });
  const repo = getChatRepository();

  const quota = getChelCoachConfig().quotas.maxDailyChatMessagesPerUser;
  const sinceIso = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const used = await repo.countUserTurnsSince(input.ownerId, sinceIso);
  if (used >= quota) {
    throw new ChatServiceError(429, "RATE_LIMITED", "You have reached today's limit for questions to Scottie. Try again tomorrow.", true);
  }

  const provider = getScottyProvider();
  if (!provider.chat) {
    throw new ChatServiceError(503, "PROVIDER_UNAVAILABLE", "Chat is not available with the current analysis provider.", false);
  }

  const history = await repo.listByRequest(input.applicationRequestId, CHAT_CONTEXT_TURNS - 1);
  const turns = [...history.map((m) => ({ role: m.role, content: m.content })), { role: "user" as const, content }];

  let result: Awaited<ReturnType<NonNullable<typeof provider.chat>>>;
  try {
    result = await provider.chat({ reportContext: buildReportContext(envelope.report), turns });
  } catch (err) {
    if (err instanceof ProviderError) {
      throw new ChatServiceError(503, "PROVIDER_UNAVAILABLE", "Scottie is unavailable right now. Your question was not counted.", true);
    }
    throw err;
  }

  // Persist only after a successful reply so a provider outage never burns the daily quota.
  await repo.append({ applicationRequestId: input.applicationRequestId, ownerId: input.ownerId, role: "user", content, model: null });
  const saved = await repo.append({
    applicationRequestId: input.applicationRequestId,
    ownerId: input.ownerId,
    role: "assistant",
    content: result.reply.slice(0, 4_000),
    model: result.model ?? null,
  });
  console.log(`[chelcoach-chat] event=chat_turn applicationRequestId=${input.applicationRequestId} provider=${result.provider} model=${result.model ?? "-"} used=${used + 1}/${quota}`);
  const messages = (await repo.listByRequest(input.applicationRequestId, CHAT_HISTORY_LIMIT)).map(toPublic);
  return { reply: toPublic(saved), messages };
}
