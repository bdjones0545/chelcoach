import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import Button from "../components/Button";
import GlassPanel from "../components/GlassPanel";
import Icon from "../components/Icon";
import StatePanel from "../components/StatePanel";
import { processingMessages, stateCopy } from "../data/mockData";
import { useAnalysis } from "../state/AnalysisContext";

export default function Processing() {
  const navigate = useNavigate();
  const location = useLocation();
  const { markAnalyzed } = useAnalysis();

  const [progress, setProgress] = useState(0);
  const [messageIndex, setMessageIndex] = useState(0);
  const [frames, setFrames] = useState(0);
  const [failed, setFailed] = useState(false);
  const done = progress >= 100;

  // Mock failure: reachable via /processing?state=fail (e.g. from a real upload error).
  const failArmed = useRef(new URLSearchParams(location.search).get("state") === "fail");
  const raf = useRef<number>(0);

  const startRun = useCallback(() => {
    window.clearTimeout(raf.current);
    let current = 0;
    setFailed(false);
    setProgress(0);
    setFrames(0);
    setMessageIndex(0);

    const tick = () => {
      // Simulated mid-review failure.
      if (failArmed.current && current >= 42) {
        setFailed(true);
        return;
      }
      current = Math.min(100, current + (current > 90 ? 0.4 : Math.random() * 2.2));
      setProgress(current);
      setFrames((f) => f + Math.floor(Math.random() * 48) + 12);
      setMessageIndex(Math.min(processingMessages.length - 1, Math.floor(current / (100 / processingMessages.length))));
      if (current < 100) {
        // Plain timer (not requestAnimationFrame) so progress keeps advancing even if
        // the tab is backgrounded during the analysis.
        raf.current = window.setTimeout(tick, 110);
      }
    };
    raf.current = window.setTimeout(tick, 600);
  }, []);

  useEffect(() => {
    startRun();
    return () => window.clearTimeout(raf.current);
  }, [startRun]);

  // On success, record the analysis and advance to the scorecard.
  useEffect(() => {
    if (!done) return;
    markAnalyzed();
    const t = setTimeout(() => navigate("/scorecard"), 1100);
    return () => clearTimeout(t);
  }, [done, markAnalyzed, navigate]);

  const goToScorecard = () => {
    markAnalyzed();
    navigate("/scorecard");
  };

  const retry = () => {
    failArmed.current = false; // second attempt succeeds
    startRun();
  };

  return (
    <div className="relative min-h-screen overflow-hidden bg-surface-container-lowest">
      {/* Digital scan-field backdrop */}
      <div className="pointer-events-none absolute inset-0 opacity-60">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_center,rgba(0,163,255,0.18),transparent_55%)]" />
        <div className="absolute inset-0 hex-bg" />
      </div>

      <div className="absolute left-1/2 top-12 flex -translate-x-1/2 items-center gap-3">
        <Icon name="analytics" className="text-3xl text-primary" fill />
        <span className="font-headline-md text-headline-md font-bold tracking-tighter text-primary">ChelCoach</span>
      </div>

      <main className="relative z-10 flex min-h-screen flex-col items-center justify-center gap-12 px-gutter">
        {failed ? (
          <StatePanel
            icon={stateCopy.processingFailed.icon}
            tone={stateCopy.processingFailed.tone}
            title={stateCopy.processingFailed.title}
            message={stateCopy.processingFailed.message}
            primary={{ label: stateCopy.processingFailed.primaryLabel, onClick: retry }}
            secondary={{ label: stateCopy.processingFailed.secondaryLabel, onClick: () => navigate("/upload") }}
          />
        ) : (
          <>
            <div className="relative flex h-64 w-64 items-center justify-center">
              <div className="absolute inset-0 animate-ping rounded-full border border-primary/20" />
              <div className="absolute inset-4 animate-[ping_2s_infinite] rounded-full border border-primary/40" />
              <div className="glass-panel relative flex h-48 w-48 flex-col items-center justify-center overflow-hidden rounded-full">
                <div className="scanner-line absolute left-0 top-0 h-1/2 w-full" />
                <span className="font-headline-xl text-headline-xl text-primary drop-shadow-xl">
                  {Math.floor(progress)}%
                </span>
                <span className="font-label-sm text-label-sm uppercase tracking-widest text-primary/80">
                  {done ? "Complete" : "Optimizing"}
                </span>
              </div>
            </div>

            <div className="space-y-4 text-center">
              <h1 className="mx-auto max-w-lg font-headline-lg text-headline-lg-mobile text-on-surface md:text-headline-lg">
                Your AI Coaching Staff Is Reviewing Your Game
              </h1>
              <div className="flex h-8 items-center justify-center">
                <p key={messageIndex} className="status-fade-in font-label-md text-label-md text-tertiary">
                  {done ? "Report ready." : processingMessages[messageIndex]}
                </p>
              </div>
            </div>

            <GlassPanel className="w-full max-w-md space-y-6 p-6">
              <div className="space-y-2">
                <div className="flex items-end justify-between">
                  <span className="font-label-sm text-label-sm uppercase text-on-surface-variant">Current Phase</span>
                  <span className="font-label-sm text-label-sm text-primary">Tactical Extraction</span>
                </div>
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-container">
                  <div
                    className="shimmer h-full rounded-full bg-primary transition-all duration-700 ease-out"
                    style={{ width: `${progress}%` }}
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="flex flex-col gap-1">
                  <span className="font-label-sm text-label-sm text-on-surface-variant">Estimated completion</span>
                  <span className="font-body-md text-body-md font-bold text-primary">Under a minute</span>
                </div>
                <div className="flex flex-col gap-1 text-right">
                  <span className="font-label-sm text-label-sm text-on-surface-variant">Analyzed Frames</span>
                  <span className="font-body-md text-body-md font-bold text-on-surface">{frames.toLocaleString()}</span>
                </div>
              </div>
            </GlassPanel>

            <Button size="md" trailingIcon="arrow_forward" className="group" onClick={goToScorecard}>
              {done ? "View My Scorecard" : "Skip to Scorecard"}
            </Button>
          </>
        )}
      </main>
    </div>
  );
}
