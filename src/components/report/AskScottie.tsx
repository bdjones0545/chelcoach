import { useMemo } from "react";
import ChatPanel, { type ChatThread } from "../ChatPanel";
import { getChat, sendChat } from "../../lib/chatApi";

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
  const thread = useMemo<ChatThread>(
    () => ({
      key: `report:${applicationRequestId}`,
      load: (signal) => getChat(applicationRequestId, signal),
      send: (message) => sendChat(applicationRequestId, message),
    }),
    [applicationRequestId],
  );
  return (
    <ChatPanel
      thread={thread}
      sectionId="chat"
      testId="report-ask-scottie"
      title="Ask Scottie"
      subtitle="Answers come only from this report's sampled frames — Scottie will say when a question is outside them."
      suggestions={SUGGESTIONS}
      emptyText="No questions yet. Try one of these, or ask your own."
      thinkingText="Scottie is looking at your report…"
      placeholder="Ask about a moment, a habit, or what to practice…"
      inputLabel="Ask Scottie about this clip"
    />
  );
}
