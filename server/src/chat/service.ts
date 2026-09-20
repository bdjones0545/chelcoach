/**
 * "Ask Scottie" — chat about one completed coaching report — and the standing "Scottie" coaching
 * chat a player opens from the nav.
 *
 * Report chat: ownership and readiness come from getAnalysisReport(): only the owner, only once
 * the report exists. Coach chat: one thread per owner (COACH_THREAD_PREFIX + ownerId), grounded in
 * the owner's most recent completed report when there is one, otherwise general coaching with the
 * gateway told plainly that no film has been seen. The provider is stateless; ChelCoach keeps the turns (chat/repository.ts) and sends the
 * report plus the recent turns on every call. Every user turn is a paid model call, so a durable
 * per-user daily cap is enforced here, not in the per-instance rate bucket.
 */
import { getChelCoachConfig } from "../config/chelcoachConfig";
import { ProviderError } from "../provider/errors";
import { getScottyProvider } from "../provider/factory";
import { getAnalysisJobRepository } from "../provider/jobs/jobRepository";
import { getAnalysisReport } from "../provider/statusService";
import type { ScottyProvider, ScottyChatMode } from "../provider/types";
import { scottyReportSchema, type ScottyReport } from "../scottyContract";
import { getChatRepository, type ChatMessageRecord } from "./repository";

export const MAX_CHAT_MESSAGE_CHARS = 1_500;
/** Turns sent to the provider as context (oldest dropped first). */
export const CHAT_CONTEXT_TURNS = 12;
/** Turns returned to the UI. */
export const CHAT_HISTORY_LIMIT = 100;
/** Thread key for the per-owner coaching chat (no FK on the chat table, so a prefix keeps it apart from request ids). */
export const COACH_THREAD_PREFIX = "coach:";
/** How many recent jobs to scan for the latest completed report. */
const LATEST_REPORT_SCAN = 25;

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

type SendOutcome = { reply: PublicChatMessage; messages: PublicChatMessage[] };

function normaliseMessage(message: unknown): string {
  const content = typeof message === "string" ? message.replace(/\s+/g, " ").trim() : "";
  if (!content) throw new ChatServiceError(400, "INVALID_REQUEST", "Write a question first.");
  if (content.length > MAX_CHAT_MESSAGE_CHARS) {
    throw new ChatServiceError(400, "INVALID_REQUEST", `Keep it under ${MAX_CHAT_MESSAGE_CHARS} characters.`);
  }
  return content;
}

async function assertDailyQuota(ownerId: string): Promise<{ used: number; quota: number }> {
  const quota = getChelCoachConfig().quotas.maxDailyChatMessagesPerUser;
  const sinceIso = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const used = await getChatRepository().countUserTurnsSince(ownerId, sinceIso);
  if (used >= quota) {
    throw new ChatServiceError(429, "RATE_LIMITED", "You have reached today's limit for questions to Scottie. Try again tomorrow.", true);
  }
  return { used, quota };
}

function chatCapableProvider(): ScottyProvider & { chat: NonNullable<ScottyProvider["chat"]> } {
  const provider = getScottyProvider();
  if (!provider.chat) {
    throw new ChatServiceError(503, "PROVIDER_UNAVAILABLE", "Chat is not available with the current analysis provider.", false);
  }
  return provider as ScottyProvider & { chat: NonNullable<ScottyProvider["chat"]> };
}

/** Ask the provider, then persist both turns — only after a reply, so an outage never burns quota. */
async function askAndPersist(input: {
  threadId: string;
  ownerId: string;
  content: string;
  mode: ScottyChatMode;
  reportContext: Record<string, unknown> | null;
  used: number;
  quota: number;
}): Promise<SendOutcome> {
  const repo = getChatRepository();
  const provider = chatCapableProvider();
  const history = await repo.listByRequest(input.threadId, CHAT_CONTEXT_TURNS - 1);
  const turns = [...history.map((m) => ({ role: m.role, content: m.content })), { role: "user" as const, content: input.content }];

  let result: Awaited<ReturnType<typeof provider.chat>>;
  try {
    result = await provider.chat({ mode: input.mode, reportContext: input.reportContext, turns });
  } catch (err) {
    if (err instanceof ProviderError) {
      throw new ChatServiceError(503, "PROVIDER_UNAVAILABLE", "Scottie is unavailable right now. Your question was not counted.", true);
    }
    throw err;
  }

  await repo.append({ applicationRequestId: input.threadId, ownerId: input.ownerId, role: "user", content: input.content, model: null });
  const saved = await repo.append({
    applicationRequestId: input.threadId,
    ownerId: input.ownerId,
    role: "assistant",
    content: result.reply.slice(0, 4_000),
    model: result.model ?? null,
  });
  console.log(`[chelcoach-chat] event=chat_turn mode=${input.mode} grounded=${input.reportContext !== null} thread=${input.threadId} provider=${result.provider} model=${result.model ?? "-"} used=${input.used + 1}/${input.quota}`);
  const messages = (await repo.listByRequest(input.threadId, CHAT_HISTORY_LIMIT)).map(toPublic);
  return { reply: toPublic(saved), messages };
}

export async function sendChat(input: {
  ownerId: string;
  applicationRequestId: string;
  message: unknown;
}): Promise<SendOutcome> {
  const content = normaliseMessage(input.message);
  const envelope = await getAnalysisReport({ ownerId: input.ownerId, applicationRequestId: input.applicationRequestId });
  const { used, quota } = await assertDailyQuota(input.ownerId);
  return askAndPersist({
    threadId: input.applicationRequestId,
    ownerId: input.ownerId,
    content,
    mode: "report",
    reportContext: buildReportContext(envelope.report),
    used,
    quota,
  });
}

// ---------------------------------------------------------------------------------------------
// Coach chat (per owner, always available)

/** What the UI shows about the report Scottie is currently grounded in. */
export interface CoachGrounding {
  applicationRequestId: string;
  gameTitle: string | null;
  gameMode: string | null;
  completedAt: string | null;
}

async function latestCompletedReport(ownerId: string): Promise<{ grounding: CoachGrounding; report: ScottyReport } | null> {
  const jobs = await getAnalysisJobRepository().listByOwner(ownerId, LATEST_REPORT_SCAN);
  for (const job of jobs) {
    if (job.canonicalStatus !== "completed") continue;
    const stored = await getAnalysisJobRepository().getReportByApplicationRequestId(job.applicationRequestId);
    if (!stored) continue;
    const parsed = scottyReportSchema.safeParse(stored.report);
    if (!parsed.success) continue;
    return {
      grounding: {
        applicationRequestId: job.applicationRequestId,
        gameTitle: job.uploadContext.gameContext.selectedGameTitle ?? null,
        gameMode: job.uploadContext.playerContext.gameMode ?? null,
        completedAt: job.completedAt ?? null,
      },
      report: parsed.data,
    };
  }
  return null;
}

export function coachThreadId(ownerId: string): string {
  return `${COACH_THREAD_PREFIX}${ownerId}`;
}

export async function listCoachChat(input: { ownerId: string }): Promise<{ messages: PublicChatMessage[]; grounding: CoachGrounding | null }> {
  const [rows, latest] = await Promise.all([
    getChatRepository().listByRequest(coachThreadId(input.ownerId), CHAT_HISTORY_LIMIT),
    latestCompletedReport(input.ownerId),
  ]);
  return { messages: rows.map(toPublic), grounding: latest?.grounding ?? null };
}

export async function sendCoachChat(input: { ownerId: string; message: unknown }): Promise<SendOutcome & { grounding: CoachGrounding | null }> {
  const content = normaliseMessage(input.message);
  const { used, quota } = await assertDailyQuota(input.ownerId);
  const latest = await latestCompletedReport(input.ownerId);
  const outcome = await askAndPersist({
    threadId: coachThreadId(input.ownerId),
    ownerId: input.ownerId,
    content,
    mode: "coach",
    reportContext: latest ? buildReportContext(latest.report) : null,
    used,
    quota,
  });
  return { ...outcome, grounding: latest?.grounding ?? null };
}
