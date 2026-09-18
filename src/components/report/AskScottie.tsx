import { useEffect, useRef, useState, type FormEvent } from "react";
import GlassPanel from "../GlassPanel";
import Icon from "../Icon";
import { ChatApiError, getChat, sendChat, type ChatMessage } from "../../lib/chatApi";

const SUGGESTIONS = [
  "What should I fix first?",
  "Walk me through my biggest mistake.",
  "What did I do well in this clip?",
  "Give me one drill for this week.",
];

/**
 * Chat with Scottie about this report. Scottie answers only from the report's sampled frames;
 * the panel says so, and every reply is labelled as coming from the analysis model.
 */
export default function AskScottie({ applicationRequestId }: { applicationRequestId: string }) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    getChat(applicationRequestId, controller.signal)
      .then((m) => {
        if (!controller.signal.aborted) setMessages(m);
      })
      .catch((err: unknown) => {
        if (!controller.signal.aborted) setError(err instanceof Error ? err.message : "Could not load the conversation.");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [applicationRequestId]);

  useEffect(() => {
    endRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [messages.length, sending]);

  const ask = async (text: string) => {
    const message = text.trim();
    if (!message || sending) return;
    setSending(true);
    setError(null);
    setDraft("");
    // Show the question immediately; the API returns the canonical list after the reply.
    const optimistic: ChatMessage = { id: `local-${Date.now()}`, role: "user", content: message, createdAt: new Date().toISOString() };
    setMessages((m) => [...m, optimistic]);
    try {
      const result = await sendChat(applicationRequestId, message);
      setMessages(result.messages);
    } catch (err) {
      setMessages((m) => m.filter((x) => x.id !== optimistic.id));
      setDraft(message);
      setError(err instanceof ChatApiError ? err.message : "Scottie could not answer right now.");
    } finally {
      setSending(false);
    }
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    void ask(draft);
  };

  return (
    <section id="chat" aria-labelledby="chat-heading" data-testid="report-ask-scottie">
      <GlassPanel className="space-y-4 border-l-4 border-l-primary p-6">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="chat-heading" className="font-headline-lg text-headline-lg uppercase text-on-surface">
            Ask Scottie
          </h2>
          <p className="font-label-sm text-label-sm text-on-surface-variant">
            Answers come only from this report's sampled frames — Scottie will say when a question is outside them.
          </p>
        </div>

        <div className="max-h-[28rem] space-y-3 overflow-y-auto pr-1" role="log" aria-live="polite" aria-busy={sending}>
          {loading && <p className="font-body-md text-on-surface-variant">Loading the conversation…</p>}
          {!loading && messages.length === 0 && (
            <p className="font-body-md text-on-surface-variant">No questions yet. Try one of these, or ask your own.</p>
          )}
          {messages.map((m) => (
            <div
              key={m.id}
              data-testid={`chat-${m.role}`}
              className={
                m.role === "user"
                  ? "ml-auto max-w-[85%] rounded-xl bg-primary-container/20 px-4 py-3 font-body-md text-on-surface"
                  : "mr-auto max-w-[92%] rounded-xl border border-white/10 bg-surface-container/60 px-4 py-3 font-body-md text-on-surface"
              }
            >
              {m.role === "assistant" && (
                <p className="mb-1 font-label-sm text-label-sm uppercase tracking-widest text-primary">Scottie</p>
              )}
              <p className="whitespace-pre-wrap">{m.content}</p>
            </div>
          ))}
          {sending && (
            <div className="mr-auto rounded-xl border border-white/10 bg-surface-container/60 px-4 py-3 font-body-md text-on-surface-variant" data-testid="chat-thinking">
              Scottie is looking at your report…
            </div>
          )}
          <div ref={endRef} />
        </div>

        {messages.length === 0 && !loading && (
          <div className="flex flex-wrap gap-2">
            {SUGGESTIONS.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => void ask(s)}
                disabled={sending}
                className="rounded-full border border-white/15 px-3 py-1.5 font-label-sm text-label-sm text-on-surface-variant transition-colors hover:border-primary hover:text-primary disabled:opacity-50"
              >
                {s}
              </button>
            ))}
          </div>
        )}

        {error && (
          <p role="alert" className="font-body-md text-error">
            {error}
          </p>
        )}

        <form onSubmit={onSubmit} className="flex items-end gap-2">
          <label htmlFor="ask-scottie-input" className="sr-only">
            Ask Scottie about this clip
          </label>
          <textarea
            id="ask-scottie-input"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void ask(draft);
              }
            }}
            rows={2}
            maxLength={1500}
            placeholder="Ask about a moment, a habit, or what to practice…"
            disabled={sending || loading}
            className="min-h-[3rem] flex-1 resize-y rounded-xl border border-white/15 bg-surface-container/60 px-4 py-3 font-body-md text-on-surface placeholder:text-on-surface-variant/70 focus:border-primary focus:outline-none disabled:opacity-60"
          />
          <button
            type="submit"
            disabled={sending || loading || !draft.trim()}
            className="flex h-12 items-center gap-2 rounded-xl bg-primary-container px-4 font-label-md text-label-md uppercase tracking-wide text-on-primary-container transition-transform active:scale-95 disabled:opacity-50"
          >
            <Icon name="send" />
            Ask
          </button>
        </form>
      </GlassPanel>
    </section>
  );
}
