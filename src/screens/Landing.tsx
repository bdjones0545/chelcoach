import { useNavigate } from "react-router-dom";
import AtmosphereBackground from "../components/AtmosphereBackground";
import Button from "../components/Button";
import GlassPanel from "../components/GlassPanel";
import Icon from "../components/Icon";
import Logo from "../components/Logo";
import { useAnalysis } from "../state/AnalysisContext";

const steps = [
  { icon: "cloud_upload", title: "Upload a clip", detail: "Drop in one MP4 or MOV of your NHL game." },
  { icon: "query_stats", title: "Get your Chel Rating", detail: "A free coach-grade scorecard in under a minute." },
  { icon: "lock_open", title: "Unlock coaching insights", detail: "See every mistake — and exactly how to fix it." },
  { icon: "trending_up", title: "Win your next game", detail: "Walk in knowing your top priorities." },
];

export default function Landing() {
  const navigate = useNavigate();
  const { markAnalyzed } = useAnalysis();

  // The demo report populates the whole flow (scorecard + film room) with sample data.
  const viewDemo = () => {
    markAnalyzed();
    navigate("/scorecard");
  };

  return (
    <div className="flex min-h-screen flex-col overflow-x-hidden">
      <AtmosphereBackground />

      <header className="fixed top-0 z-50 flex h-16 w-full items-center justify-between border-b border-white/10 bg-surface-container/80 px-margin-mobile backdrop-blur-xl md:px-gutter">
        <Logo />
        <button
          type="button"
          className="font-label-md text-label-md text-on-surface-variant transition-colors hover:text-primary"
          onClick={() => navigate("/login")}
        >
          Sign In
        </button>
      </header>

      <main className="relative z-10 flex flex-grow flex-col items-center justify-center px-margin-mobile pb-20 pt-28 md:px-margin-desktop">
        <div className="flex w-full max-w-4xl flex-col items-center space-y-8 text-center">
          <div className="inline-flex animate-pulse items-center gap-2 rounded-full border border-primary/20 bg-primary/5 px-4 py-1.5 backdrop-blur-sm">
            <Icon name="auto_awesome" className="text-sm text-primary" fill />
            <span className="font-label-sm text-label-sm uppercase tracking-[0.2em] text-primary">
              AI Gameplay Coach
            </span>
          </div>

          <div className="space-y-4">
            <h1 className="font-headline-xl text-[40px] uppercase leading-tight md:text-headline-xl">
              Improve Your NHL{" "}
              <span className="block text-primary-container drop-shadow-[0_0_15px_rgba(0,163,255,0.4)] md:inline">
                Gameplay with AI
              </span>
            </h1>
            <p className="font-headline-md text-headline-md uppercase tracking-wide text-primary">
              Upload a clip. Get your Chel Rating.
            </p>
            <p className="mx-auto max-w-2xl font-body-lg text-body-lg text-on-surface-variant">
              Get a coach-style breakdown of your mistakes, your strengths, and exactly what to fix before your next
              game.
            </p>
          </div>

          <div className="flex flex-col items-center gap-3 pt-4">
            <div className="flex flex-col items-center gap-4 sm:flex-row">
              <Button className="group" icon="cloud_upload" onClick={() => navigate("/upload")}>
                Analyze My Gameplay
              </Button>
              <Button variant="ghost" onClick={viewDemo}>
                View Demo Report
              </Button>
            </div>
            <p className="font-label-sm text-label-sm text-on-surface-variant">
              Free to start · No sign-up · Your first Chel Rating in under a minute
            </p>
          </div>

          <div className="mt-14 grid w-full max-w-5xl grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {steps.map((step, i) => (
              <GlassPanel key={step.title} className="flex flex-col items-start gap-4 p-6 text-left">
                <div className="flex items-center gap-3">
                  <div className="rounded-lg bg-primary-container/10 p-2">
                    <Icon name={step.icon} className="text-primary" />
                  </div>
                  <span className="font-label-sm text-label-sm text-on-surface-variant">Step {i + 1}</span>
                </div>
                <div>
                  <h3 className="font-headline-md text-headline-md text-on-surface">{step.title}</h3>
                  <p className="mt-1 font-label-sm text-label-sm text-on-surface-variant">{step.detail}</p>
                </div>
              </GlassPanel>
            ))}
          </div>
        </div>
      </main>

      <footer className="relative z-10 flex flex-col items-center justify-between gap-4 px-gutter py-8 text-on-surface-variant md:flex-row">
        <span className="flex items-center gap-2 font-label-sm text-label-sm">
          <span className="h-2 w-2 animate-pulse rounded-full bg-tertiary" />
          AI Core Online
        </span>
        <span className="font-label-sm text-label-sm">ChelCoach · NHL Gameplay Coaching</span>
      </footer>
    </div>
  );
}
