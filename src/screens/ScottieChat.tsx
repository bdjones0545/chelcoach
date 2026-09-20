import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import BottomNav from "../components/BottomNav";
import ChatPanel, { type ChatThread } from "../components/ChatPanel";
import Icon from "../components/Icon";
import TopAppBar from "../components/TopAppBar";
import { analysisReportPath } from "../lib/analysisRequestId";
import { getCoachChat, sendCoachChat, type CoachGrounding } from "../lib/chatApi";

const SUGGESTIONS = [
  "How do I stop getting walked on the rush?",
  "What should a winger do on the forecheck in EASHL?",
  "Give me a warm-up routine before a competitive game.",
  "What should I fix first from my latest clip?",
];

function GroundingBanner({ grounding, loaded }: { grounding: CoachGrounding | null; loaded: boolean }) {
  if (!loaded) return null;
  if (grounding) {
    const when = grounding.completedAt ? new Date(grounding.completedAt).toLocaleDateString() : null;
    return (
      <p
        data-testid="coach-grounding"
        className="flex flex-wrap items-center gap-2 rounded-xl border border-primary/30 bg-primary-container/10 px-4 py-3 font-body-md text-on-surface"
      >
        <Icon name="movie" className="text-primary" />
        <span>
          Scottie is looking at your latest report{grounding.gameTitle ? ` (${grounding.gameTitle}` : ""}
          {grounding.gameTitle && when ? `, ${when})` : grounding.gameTitle ? ")" : when ? ` (${when})` : ""}.
        </span>
        <Link to={analysisReportPath(grounding.applicationRequestId)} className="text-primary hover:underline">
          Open it
        </Link>
      </p>
    );
  }
  return (
    <p
      data-testid="coach-ungrounded"
      className="flex flex-wrap items-center gap-2 rounded-xl border border-white/10 bg-surface-container/60 px-4 py-3 font-body-md text-on-surface-variant"
    >
      <Icon name="videocam_off" />
      <span>Scottie hasn’t seen your film yet — ask anything about Chel, and</span>
      <Link to="/upload" className="text-primary hover:underline">
        upload a clip
      </Link>
      <span>for coaching on your own play.</span>
    </p>
  );
}

/**
 * The standing Scottie tab: always available after sign-in. Grounded in the player's latest
 * completed report when there is one; otherwise general coaching that says so.
 */
export default function ScottieChat() {
  const [grounding, setGrounding] = useState<CoachGrounding | null>(null);
  const [loaded, setLoaded] = useState(false);

  const thread = useMemo<ChatThread>(
    () => ({
      key: "coach",
      load: async (signal) => {
        const state = await getCoachChat(signal);
        setGrounding(state.grounding);
        setLoaded(true);
        return state.messages;
      },
      send: async (message) => {
        const result = await sendCoachChat(message);
        setGrounding(result.grounding);
        return result;
      },
    }),
    [],
  );

  return (
    <div className="min-h-screen bg-background pb-32">
      <TopAppBar />
      <main className="mx-auto max-w-container-max px-4 pt-24 md:px-gutter">
        <div className="mb-6 text-center md:text-left">
          <h1 className="mb-2 font-headline-xl text-[32px] uppercase text-on-surface md:text-headline-xl">Scottie</h1>
          <p className="max-w-2xl font-body-lg text-body-lg text-on-surface-variant">
            Your film-room coach. Ask how to get better — Scottie only claims to know your play from clips you’ve had analyzed.
          </p>
        </div>
        <ChatPanel
          thread={thread}
          sectionId="coach-chat"
          testId="scottie-coach-chat"
          title="Talk hockey"
          subtitle="General coaching any time; specific feedback once Scottie has seen a clip."
          suggestions={SUGGESTIONS}
          emptyText="Nothing yet. Try one of these, or ask your own."
          thinkingText="Scottie is thinking…"
          placeholder="Ask about positioning, a bad habit, a mode, or what to practice…"
          inputLabel="Ask Scottie a coaching question"
          banner={<GroundingBanner grounding={grounding} loaded={loaded} />}
        />
      </main>
      <BottomNav active="scottie" />
    </div>
  );
}
