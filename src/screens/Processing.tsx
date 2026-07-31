import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import Button from "../components/Button";
import GlassPanel from "../components/GlassPanel";
import Icon from "../components/Icon";
import StatePanel from "../components/StatePanel";
import { processingMessages, stateCopy, type StatePanelCopy } from "../data/mockData";
import { USE_BACKEND_REPORTS, fetchAnalysisJobStatus, fetchClipReport } from "../lib/reportApi";
import { pollAnalysisStatus, type PollOutcome } from "../lib/pollStatus";
import { useAnalysis } from "../state/AnalysisContext";
import { useReport } from "../state/ReportContext";
import type { AnalysisJobStatus } from "../../shared/analysisContract";

type LivePhase =
  | "preparing"
  | "queued"
  | "processing"
  | "completed"
  | "failed"
  | "timeout"
  | "unreachable"
  | "invalid";

function phaseFromStatus(status: AnalysisJobStatus["status"]): Exclude<LivePhase, "preparing" | "timeout" | "unreachable" | "invalid" | "completed"> {
  if (status === "failed") return "failed";
  if (status === "queued") return "queued";
  return "processing";
}

function statusLabel(phase: LivePhase, serverMessage?: string): string {
  if (serverMessage) return serverMessage;
  switch (phase) {
    case "preparing":
      return "Preparing your analysis…";
    case "queued":
      return "Queued for analysis…";
    case "processing":
      return "Analyzing your clip…";
    case "completed":
      return "Report ready.";
    default:
      return "Working…";
  }
}

function stageLabel(phase: LivePhase, stage?: string): string {
  if (stage === "ready") return "Ready";
  if (stage === "queued") return "Queued";
  if (stage === "inspecting_video") return "Inspecting";
  if (stage === "extracting_frames") return "Extracting";
  if (stage === "analyzing_gameplay") return "Analyzing";
  if (stage === "validating_report") return "Validating";
  if (stage === "finalizing") return "Finalizing";
  if (phase === "preparing") return "Preparing";
  if (phase === "completed") return "Complete";
  return "In progress";
}

export default function Processing() {
  const navigate = useNavigate();
  const { markAnalyzed, activeClipId, clearActiveClip, reset: resetAnalysis } = useAnalysis();
  const { acceptLiveReport, restoreDemoReport, backendEnabled } = useReport();

  // Intentional demo: flag off, or no active live clip id.
  const isDemoMode = !backendEnabled || !USE_BACKEND_REPORTS || !activeClipId;

  // --- Demo (cosmetic) state -------------------------------------------------
  const [demoProgress, setDemoProgress] = useState(0);
  const [messageIndex, setMessageIndex] = useState(0);
  const demoTimer = useRef<number>(0);
  const demoDone = demoProgress >= 100;

  // --- Live (server-driven) state --------------------------------------------
  const [livePhase, setLivePhase] = useState<LivePhase>("preparing");
  const [liveStatus, setLiveStatus] = useState<AnalysisJobStatus | null>(null);
  const [liveProgress, setLiveProgress] = useState(0);
  const pollAbort = useRef<AbortController | null>(null);
  const reportFetched = useRef(false);
  const navigated = useRef(false);
  const pollGeneration = useRef(0);

  const goToScorecardOnce = useCallback(() => {
    if (navigated.current) return;
    navigated.current = true;
    markAnalyzed();
    navigate("/scorecard");
  }, [markAnalyzed, navigate]);

  // Demo path: animation may drive completion (no server job exists).
  const startDemoRun = useCallback(() => {
    window.clearTimeout(demoTimer.current);
    let current = 0;
    setDemoProgress(0);
    setMessageIndex(0);
    const tick = () => {
      current = Math.min(100, current + (current > 90 ? 0.4 : Math.random() * 2.2));
      setDemoProgress(current);
      setMessageIndex(
        Math.min(processingMessages.length - 1, Math.floor(current / (100 / processingMessages.length))),
      );
      if (current < 100) demoTimer.current = window.setTimeout(tick, 110);
    };
    demoTimer.current = window.setTimeout(tick, 600);
  }, []);

  useEffect(() => {
    if (!isDemoMode) return;
    startDemoRun();
    return () => window.clearTimeout(demoTimer.current);
  }, [isDemoMode, startDemoRun]);

  useEffect(() => {
    if (!isDemoMode || !demoDone) return;
    const t = window.setTimeout(() => goToScorecardOnce(), 1100);
    return () => window.clearTimeout(t);
  }, [isDemoMode, demoDone, goToScorecardOnce]);

  // Live path: server status determines completion — never the animation timer.
  const runLivePoll = useCallback(async () => {
    if (!activeClipId) return;
    const generation = ++pollGeneration.current;
    pollAbort.current?.abort();
    const controller = new AbortController();
    pollAbort.current = controller;
    reportFetched.current = false;
    navigated.current = false;
    setLivePhase("preparing");
    setLiveStatus(null);
    setLiveProgress(0);

    const outcome: PollOutcome = await pollAnalysisStatus({
      signal: controller.signal,
      fetchStatus: async () => {
        const status = await fetchAnalysisJobStatus(activeClipId, controller.signal);
        if (generation !== pollGeneration.current) return status;
        setLiveStatus(status);
        setLiveProgress(status.phaseProgress ?? (status.status === "queued" ? 25 : 60));
        if (status.status !== "completed" && status.status !== "failed") {
          setLivePhase(phaseFromStatus(status.status));
        }
        return status;
      },
    });

    if (generation !== pollGeneration.current || controller.signal.aborted) return;

    if (outcome.outcome === "aborted") return;

    if (outcome.outcome === "completed") {
      setLivePhase("completed");
      setLiveProgress(100);
      setLiveStatus(outcome.status);
      if (reportFetched.current) return;
      reportFetched.current = true;
      try {
        const report = await fetchClipReport(activeClipId, controller.signal);
        if (generation !== pollGeneration.current || controller.signal.aborted) return;
        acceptLiveReport(report);
        window.setTimeout(() => goToScorecardOnce(), 800);
      } catch {
        reportFetched.current = false;
        setLivePhase("unreachable");
      }
      return;
    }

    if (outcome.outcome === "failed") {
      setLivePhase("failed");
      setLiveStatus(outcome.status);
      return;
    }
    if (outcome.outcome === "timeout") {
      setLivePhase("timeout");
      return;
    }
    if (outcome.outcome === "unreachable") {
      setLivePhase("unreachable");
      return;
    }
    if (outcome.outcome === "invalid") {
      setLivePhase("invalid");
    }
  }, [activeClipId, acceptLiveReport, goToScorecardOnce]);

  useEffect(() => {
    if (isDemoMode) return;
    void runLivePoll();
    return () => {
      pollGeneration.current += 1;
      pollAbort.current?.abort();
    };
  }, [isDemoMode, runLivePoll]);

  const retryLive = () => {
    void runLivePoll();
  };

  const backToUpload = () => {
    pollAbort.current?.abort();
    clearActiveClip();
    navigate("/upload");
  };

  const startOver = () => {
    pollAbort.current?.abort();
    resetAnalysis();
    restoreDemoReport();
    navigate("/");
  };

  const failureCopy = (): StatePanelCopy | null => {
    if (isDemoMode) return null;
    switch (livePhase) {
      case "failed":
        return {
          ...stateCopy.processingFailed,
          message: liveStatus?.errorMessage ?? stateCopy.processingFailed.message,
        };
      case "timeout":
        return stateCopy.processingTimeout;
      case "unreachable":
        return stateCopy.processingUnreachable;
      case "invalid":
        return stateCopy.processingInvalid;
      default:
        return null;
    }
  };

  const failure = failureCopy();
  const progress = isDemoMode ? demoProgress : liveProgress;
  const done = isDemoMode ? demoDone : livePhase === "completed";
  const headlineMessage = isDemoMode
    ? done
      ? "Report ready."
      : processingMessages[messageIndex]
    : statusLabel(livePhase, liveStatus?.message);
  const phaseTitle = isDemoMode
    ? done
      ? "Complete"
      : "Reviewing"
    : stageLabel(livePhase, liveStatus?.stage);

  return (
    <div className="relative min-h-screen overflow-hidden bg-surface-container-lowest">
      <div className="pointer-events-none absolute inset-0 opacity-60">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_center,rgba(0,163,255,0.18),transparent_55%)]" />
        <div className="absolute inset-0 hex-bg" />
      </div>

      <div className="absolute left-1/2 top-12 flex -translate-x-1/2 items-center gap-3">
        <Icon name="analytics" className="text-3xl text-primary" fill />
        <span className="font-headline-md text-headline-md font-bold tracking-tighter text-primary">ChelCoach</span>
      </div>

      <main className="relative z-10 flex min-h-screen flex-col items-center justify-center gap-12 px-gutter">
        {failure ? (
          <StatePanel
            icon={failure.icon}
            tone={failure.tone}
            title={failure.title}
            message={failure.message}
            primary={{
              label: failure.primaryLabel,
              onClick: livePhase === "invalid" ? backToUpload : retryLive,
            }}
            secondary={{
              label: failure.secondaryLabel,
              onClick: livePhase === "invalid" ? startOver : backToUpload,
            }}
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
                  {done ? "Complete" : phaseTitle}
                </span>
              </div>
            </div>

            <div className="space-y-4 text-center">
              <h1 className="mx-auto max-w-lg font-headline-lg text-headline-lg-mobile text-on-surface md:text-headline-lg">
                Your AI Coaching Staff Is Reviewing Your Game
              </h1>
              <div className="flex h-8 items-center justify-center">
                <p key={headlineMessage} className="status-fade-in font-label-md text-label-md text-tertiary">
                  {headlineMessage}
                </p>
              </div>
            </div>

            <GlassPanel className="w-full max-w-md space-y-6 p-6">
              <div className="space-y-2">
                <div className="flex items-end justify-between">
                  <span className="font-label-sm text-label-sm uppercase text-on-surface-variant">Current Phase</span>
                  <span className="font-label-sm text-label-sm text-primary">{phaseTitle}</span>
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
                  <span className="font-body-md text-body-md font-bold text-primary">
                    {isDemoMode ? "Under a minute" : "Usually a few minutes"}
                  </span>
                </div>
                <div className="flex flex-col gap-1 text-right">
                  <span className="font-label-sm text-label-sm text-on-surface-variant">Mode</span>
                  <span className="font-body-md text-body-md font-bold text-on-surface">
                    {isDemoMode ? "Demo" : "Live"}
                  </span>
                </div>
              </div>
            </GlassPanel>

            {isDemoMode ? (
              <Button size="md" trailingIcon="arrow_forward" className="group" onClick={goToScorecardOnce}>
                {done ? "View My Scorecard" : "Skip to Scorecard"}
              </Button>
            ) : done ? (
              <Button size="md" trailingIcon="arrow_forward" className="group" onClick={goToScorecardOnce}>
                View My Scorecard
              </Button>
            ) : null}
          </>
        )}
      </main>
    </div>
  );
}
