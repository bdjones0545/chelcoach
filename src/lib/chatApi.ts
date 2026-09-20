/**
 * "Ask Scottie" — chat about one completed report — and the standing Scottie coaching chat.
 * Owner-only; the API keeps the turns.
 */
import { API_BASE_URL } from "./apiBase";
import { authenticatedFetch } from "./authenticatedFetch";

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
}

export class ChatApiError extends Error {
  readonly code: string;
  readonly httpStatus: number;
  readonly retryable: boolean;

  constructor(code: string, message: string, httpStatus: number, retryable: boolean) {
    super(message);
    this.name = "ChatApiError";
    this.code = code;
    this.httpStatus = httpStatus;
    this.retryable = retryable;
  }
}

async function parseError(res: Response): Promise<never> {
  const body = (await res.json().catch(() => ({}))) as { error?: string; message?: string; retryable?: boolean };
  const fallback =
    res.status === 401 ? "Your session expired. Sign in again to keep chatting." : res.status === 429 ? "Slow down a little — try again in a minute." : "Scottie could not answer right now.";
  throw new ChatApiError(body.error ?? "ANALYSIS_FAILED", body.message ?? fallback, res.status, Boolean(body.retryable) || res.status === 429 || res.status === 503);
}

export async function getChat(applicationRequestId: string, signal?: AbortSignal): Promise<ChatMessage[]> {
  const res = await authenticatedFetch(`${API_BASE_URL}/api/analysis/${encodeURIComponent(applicationRequestId)}/chat`, {
    headers: { accept: "application/json" },
    cache: "no-store",
    signal,
  });
  if (!res.ok) return parseError(res);
  const body = (await res.json()) as { messages?: ChatMessage[] };
  return Array.isArray(body.messages) ? body.messages : [];
}

export async function sendChat(applicationRequestId: string, message: string): Promise<{ reply: ChatMessage; messages: ChatMessage[] }> {
  const res = await authenticatedFetch(`${API_BASE_URL}/api/analysis/${encodeURIComponent(applicationRequestId)}/chat`, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ message }),
  });
  if (!res.ok) return parseError(res);
  return (await res.json()) as { reply: ChatMessage; messages: ChatMessage[] };
}

/** What the coaching chat is grounded in right now (the owner's latest completed report), if anything. */
export interface CoachGrounding {
  applicationRequestId: string;
  gameTitle: string | null;
  gameMode: string | null;
  completedAt: string | null;
}

export interface CoachChatState {
  messages: ChatMessage[];
  grounding: CoachGrounding | null;
}

export async function getCoachChat(signal?: AbortSignal): Promise<CoachChatState> {
  const res = await authenticatedFetch(`${API_BASE_URL}/api/scottie/chat`, {
    headers: { accept: "application/json" },
    cache: "no-store",
    signal,
  });
  if (!res.ok) return parseError(res);
  const body = (await res.json()) as Partial<CoachChatState>;
  return { messages: Array.isArray(body.messages) ? body.messages : [], grounding: body.grounding ?? null };
}

export async function sendCoachChat(message: string): Promise<{ reply: ChatMessage } & CoachChatState> {
  const res = await authenticatedFetch(`${API_BASE_URL}/api/scottie/chat`, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ message }),
  });
  if (!res.ok) return parseError(res);
  return (await res.json()) as { reply: ChatMessage } & CoachChatState;
}
