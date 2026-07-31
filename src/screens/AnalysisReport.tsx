/**
 * Step 8 complete coaching report experience.
 * Persisted Scotty report is authoritative — no provider calls, no invented scores.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import BottomNav from "../components/BottomNav";
import Button from "../components/Button";
import GlassPanel from "../components/GlassPanel";
import TopAppBar from "../components/TopAppBar";
import { ControlBadges } from "../components/report/ControlBadges";
import GameplayMoments from "../components/report/GameplayMoments";
import PracticePlan from "../components/report/PracticePlan";
import ReportSectionNav from "../components/report/ReportSectionNav";
import ReportSkeleton from "../components/report/ReportSkeleton";
import SourceMediaNotice from "../components/report/SourceMediaNotice";
import { getAnalysisReport, getAnalysisStatus } from "../lib/analysisClient";
import {
  clientErrorUserMessage,
  isAnalysisApiError,
  type AnalysisClientError,
} from "../lib/analysisClientErrors";
import {
  analysisStatusPath,
  parseApplicationRequestIdParam,
} from "../lib/analysisRequestId";
import { USE_BACKEND_REPORTS } from "../lib/apiBase";
import {
  buildCoachingReportView,
  type CoachingMomentView,
  type CoachingReportView,
  type ReportNavSectionId,
} from "../lib/coachingReportView";
import { emitReportTelemetry } from "../lib/reportTelemetry";

const isDevLike =
  import.meta.env.DEV || import.meta.env.MODE === "test" || import.meta.env.MODE === "development";

type LoadState =
  | { kind: "loading" }
  | { kind: "not_ready"; message: string }
  | { kind: "error"; error: AnalysisClientError | { type: "generic"; message: string } }
  | { kind: "ready"; view: CoachingReportView };

export default function AnalysisReport() {
  const navigate = useNavigate();
  const params = useParams();
  const parsed = parseApplicationRequestIdParam(params.applicationRequestId);
  const applicationRequestId = parsed.ok ? parsed.applicationRequestId : null;

  const [loadState, setLoadState] = useState<LoadState>(
    applicationRequestId
      ? { kind: "loading" }
      : {
          kind: "error",
          error: { type: "generic", message: "We could not access this analysis." },
        },
  );
  const [activeSection, setActiveSection] = useState<ReportNavSectionId>("overview");
  const [showAllPriorities, setShowAllPriorities] = useState(false);
  const [activeMomentId, setActiveMomentId] = useState<string | null>(null);
  const [activeMoment, setActiveMoment] = useState<CoachingMomentView | null>(null);
  const reloadToken = useRef(0);

  const loadReport = async () => {
    if (!USE_BACKEND_REPORTS) {
      navigate("/scorecard");
      return;
    }
    if (!applicationRequestId) {
      setLoadState({
        kind: "error",
        error: { type: "generic", message: "We could not access this analysis." },
      });
      return;
    }

    const token = ++reloadToken.current;
    setLoadState({ kind: "loading" });
    const controller = new AbortController();

    try {
      const job = await getAnalysisStatus(applicationRequestId, controller.signal);
      if (token !== reloadToken.current) return;
      if (!job.reportAvailable || job.status !== "completed") {
        setLoadState({
          kind: "not_ready",
          message: "Your coaching report is not ready yet.",
        });
        return;
      }
      const payload = await getAnalysisReport(applicationRequestId, controller.signal);
      if (token !== reloadToken.current) return;
      const view = buildCoachingReportView(payload);
      setLoadState({ kind: "ready", view });
      emitReportTelemetry("report_loaded", { applicationRequestId });
      if (!payload.sourceMediaAvailable) {
        emitReportTelemetry("video_unavailable", { applicationRequestId });
      }
    } catch (err) {
      if (token !== reloadToken.current) return;
      if (isAnalysisApiError(err)) {
        if (err.clientError.type === "server" && err.clientError.code === "REPORT_NOT_READY") {
          setLoadState({
            kind: "not_ready",
            message: "Your coaching report is not ready yet.",
          });
          return;
        }
        emitReportTelemetry("report_load_failed", {
          applicationRequestId,
          reason: err.clientError.type,
        });
        setLoadState({ kind: "error", error: err.clientError });
        return;
      }
      emitReportTelemetry("report_load_failed", {
        applicationRequestId,
        reason: "unknown",
      });
      setLoadState({
        kind: "error",
        error: {
          type: "generic",
          message: err instanceof Error ? err.message : "Failed to load report.",
        },
      });
    }
  };

  useEffect(() => {
    void loadReport();
    return () => {
      // Invalidate in-flight loads from StrictMode remounts / route changes.
      reloadToken.current += 1;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [applicationRequestId, navigate]);

  const view = loadState.kind === "ready" ? loadState.view : null;

  const visiblePriorities = useMemo(() => {
    if (!view) return [];
    return showAllPriorities
      ? view.priorities
      : view.priorities.slice(0, view.initialPriorityCount);
  }, [view, showAllPriorities]);

  const scrollToSection = (id: ReportNavSectionId) => {
    setActiveSection(id);
    emitReportTelemetry("report_section_viewed", {
      applicationRequestId: applicationRequestId ?? undefined,
      sectionId: id,
    });
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const onSelectMoment = (moment: CoachingMomentView) => {
    setActiveMomentId(moment.id);
    setActiveMoment(moment);
    // Playback deferred — retain selection + coaching note without autoplay.
  };

  return (
    <div className="analysis-report-page min-h-screen bg-surface-container-lowest pb-32">
      <TopAppBar />
      <main className="hex-bg relative mx-auto min-h-screen max-w-container-max overflow-hidden px-4 pb-8 pt-24 md:px-margin-desktop">
        <div className="pointer-events-none absolute -left-20 top-32 h-64 w-64 rounded-full bg-primary/5 blur-[120px]" />
        <div className="pointer-events-none absolute -right-16 top-48 h-56 w-56 rounded-full bg-tertiary/5 blur-[100px]" />

        {loadState.kind === "loading" && <ReportSkeleton />}

        {loadState.kind === "not_ready" && (
          <GlassPanel className="space-y-4 p-6" data-testid="report-not-ready" role="status">
            <h1 className="font-headline-xl text-[32px] uppercase text-on-surface">Coaching report</h1>
            <p className="font-body-md text-on-surface">{loadState.message}</p>
            {applicationRequestId && (
              <Button onClick={() => navigate(analysisStatusPath(applicationRequestId))}>
                Back to analysis status
              </Button>
            )}
          </GlassPanel>
        )}

        {loadState.kind === "error" && (
          <GlassPanel className="space-y-4 p-6" data-testid="report-failure" role="alert">
            <h1 className="font-headline-xl text-[32px] uppercase text-on-surface">Coaching report</h1>
            <p className="font-body-md text-error">
              {loadState.error.type === "generic"
                ? loadState.error.message
                : clientErrorUserMessage(loadState.error)}
            </p>
            {applicationRequestId && (
              <p className="font-label-sm text-label-sm text-on-surface-variant">
                Request {applicationRequestId}
              </p>
            )}
            <div className="flex flex-wrap gap-3">
              <Button onClick={() => void loadReport()}>Retry report load</Button>
              {applicationRequestId && (
                <Button
                  variant="ghost"
                  onClick={() => navigate(analysisStatusPath(applicationRequestId))}
                >
                  Back to analysis status
                </Button>
              )}
            </div>
          </GlassPanel>
        )}

        {view && (
          <div className="relative grid gap-8 lg:grid-cols-[minmax(0,1fr)_280px]">
            <div className="min-w-0 space-y-10">
              <header id="overview" data-testid="report-header" className="space-y-4">
                <p className="inline-flex rounded-full border border-white/10 bg-surface-container-highest px-3 py-1 font-label-sm text-label-sm uppercase tracking-widest text-on-surface-variant">
                  Persisted coaching report
                </p>
                <h1 className="font-headline-xl text-[32px] uppercase text-on-surface md:text-headline-xl">
                  {view.header.title}
                </h1>
                <p className="max-w-3xl font-body-lg text-body-lg text-on-surface-variant">
                  {view.header.subtitle}
                </p>
                <dl className="grid grid-cols-2 gap-3 md:grid-cols-3" data-testid="report-header-meta">
                  <MetaItem label="Game" value={view.header.gameTitle} />
                  {view.header.gameMode && <MetaItem label="Mode" value={view.header.gameMode} />}
                  <MetaItem label="Position" value={view.header.position} />
                  <MetaItem label="Platform" value={view.header.platform} />
                  <MetaItem label="Controls" value={view.header.controlScheme} />
                  {view.header.mediaClassification && (
                    <MetaItem label="Clip type" value={view.header.mediaClassification} />
                  )}
                  <MetaItem label="Analyzed" value={view.header.analysisDate} />
                  {view.header.videoDurationLabel && (
                    <MetaItem label="Duration" value={view.header.videoDurationLabel} />
                  )}
                  <MetaItem label="Player ID" value={view.header.confirmationSource} />
                </dl>
                {isDevLike && view.header.simulatorMode && (
                  <p className="font-label-sm text-label-sm text-on-surface-variant" data-testid="simulator-dev-label">
                    Local Scotty simulator
                  </p>
                )}
              </header>

              <ReportSectionNav
                sections={view.navigation}
                activeId={activeSection}
                onNavigate={scrollToSection}
              />

              <SourceMediaNotice
                available={view.sourceMedia.available}
                notice={view.sourceMedia.notice}
              />

              {/* Timestamp / evidence panel — video playback deferred; selection still works. */}
              <GlassPanel className="space-y-3 p-5" data-testid="evidence-review-panel">
                <h2 className="font-headline-md text-headline-md uppercase text-on-surface">
                  Evidence review
                </h2>
                {view.sourceMedia.available ? (
                  <p className="font-body-md text-on-surface-variant">
                    Secure in-report video playback is not enabled yet. Timestamps remain selectable and
                    coaching notes stay available.
                  </p>
                ) : (
                  <p className="font-body-md text-on-surface-variant">
                    Video playback unavailable. Selected timestamps still open the matching coaching note.
                  </p>
                )}
                {activeMoment ? (
                  <div className="rounded-lg border border-primary/30 bg-primary/5 p-4" data-testid="active-evidence-note">
                    <p className="font-label-sm uppercase text-primary">
                      Active moment{" "}
                      {activeMoment.timestampSec != null
                        ? `@ ${Math.floor(activeMoment.timestampSec / 60)}:${String(
                            Math.floor(activeMoment.timestampSec % 60),
                          ).padStart(2, "0")}`
                        : ""}
                    </p>
                    <p className="mt-2 font-body-md text-on-surface">{activeMoment.observedAction}</p>
                    <p className="mt-1 font-body-md text-on-surface-variant">{activeMoment.takeaway}</p>
                  </div>
                ) : (
                  <p className="font-body-md text-on-surface-variant">
                    Select a gameplay moment timestamp to focus this panel.
                  </p>
                )}
              </GlassPanel>

              <section id="executive" aria-labelledby="executive-heading" data-testid="report-executive-summary">
                <GlassPanel className="space-y-4 border-l-4 border-l-primary p-6">
                  <h2 id="executive-heading" className="font-headline-lg text-headline-lg uppercase text-on-surface">
                    Executive coaching summary
                  </h2>
                  <p className="font-body-lg text-on-surface">{view.executive.overallAssessment}</p>
                  <p className="font-body-md text-on-surface-variant">{view.executive.performanceSummary}</p>
                  <div className="grid gap-3 md:grid-cols-3">
                    <SummaryTile label="Strongest area" value={view.executive.strongestArea} tone="good" />
                    <SummaryTile
                      label="Highest priority"
                      value={view.executive.highestPriority}
                      tone="bad"
                    />
                    <SummaryTile
                      label="Next session"
                      value={view.executive.nextSessionObjective}
                      tone="neutral"
                    />
                  </div>
                  {/* Overall score omitted — ScottyReport contract has no overall score field. */}
                  <div data-testid="overall-score-absent" className="sr-only">
                    No overall score in report
                  </div>
                </GlassPanel>
              </section>

              {view.focusAreas.length > 0 && (
                <section id="scorecard" aria-labelledby="scorecard-heading" data-testid="report-scorecard">
                  <h2 id="scorecard-heading" className="mb-3 font-headline-lg text-headline-lg uppercase text-on-surface">
                    Performance focus areas
                  </h2>
                  <p className="mb-4 font-body-md text-on-surface-variant">
                    Evidence counts from this report — not invented scores or percentiles.
                  </p>
                  <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
                    {view.focusAreas.map((area) => (
                      <GlassPanel key={area.id} className="space-y-2 p-4">
                        <p className="font-label-sm uppercase text-on-surface-variant">{area.name}</p>
                        <p className="font-headline-md text-headline-md text-on-surface">
                          {area.evidenceCount}{" "}
                          <span className="font-label-sm text-label-sm text-on-surface-variant">
                            evidence
                          </span>
                        </p>
                        <p className="font-label-sm text-primary">{area.qualitativeLabel}</p>
                        <p className="font-body-md text-on-surface-variant">{area.interpretation}</p>
                      </GlassPanel>
                    ))}
                  </div>
                </section>
              )}

              {view.strengths.length > 0 && (
                <section id="strengths" aria-labelledby="strengths-heading" data-testid="report-strengths">
                  <h2 id="strengths-heading" className="mb-3 font-headline-lg text-headline-lg uppercase text-on-surface">
                    What You Did Well
                  </h2>
                  <div className="space-y-4">
                    {view.strengths.map((s) => (
                      <GlassPanel key={s.id} className="space-y-2 border-t-2 border-t-tertiary p-5">
                        <h3 className="font-headline-md text-headline-md uppercase text-on-surface">{s.title}</h3>
                        <p className="font-body-md text-on-surface">{s.explanation}</p>
                        <p className="font-body-md text-on-surface-variant">
                          <span className="text-on-surface">Why it matters: </span>
                          {s.whyItMatters}
                        </p>
                        <p className="font-body-md text-tertiary">
                          <span className="text-on-surface">Repeat this: </span>
                          {s.repeatThis}
                        </p>
                      </GlassPanel>
                    ))}
                  </div>
                </section>
              )}

              {view.priorities.length > 0 && (
                <section
                  id="improvements"
                  aria-labelledby="improvements-heading"
                  data-testid="report-improvements"
                >
                  <h2
                    id="improvements-heading"
                    className="mb-3 font-headline-lg text-headline-lg uppercase text-on-surface"
                  >
                    Your Biggest Opportunities
                  </h2>
                  <div className="space-y-4">
                    {visiblePriorities.map((p) => (
                      <GlassPanel key={p.id} className="space-y-2 border-t-2 border-t-error p-5">
                        <p className="font-label-sm uppercase text-error">Priority {p.rank}</p>
                        <h3 className="font-headline-md text-headline-md uppercase text-on-surface">{p.issue}</h3>
                        <p className="font-body-md text-on-surface-variant">
                          <span className="text-on-surface">Why it matters: </span>
                          {p.whyItMatters}
                        </p>
                        <p className="font-body-md text-on-surface-variant">{p.evidenceSummary}</p>
                        <p className="font-body-md text-on-surface">
                          <span className="text-on-surface-variant">Correction: </span>
                          {p.correction}
                        </p>
                        {p.mechanic && (
                          <p className="font-label-sm text-label-sm text-primary">
                            Mechanic: {p.mechanic.replace(/_/g, " ")}
                          </p>
                        )}
                        {p.linkedDrillId && (
                          <p className="font-label-sm text-label-sm text-on-surface-variant">
                            Linked drill: {p.linkedDrillId}
                          </p>
                        )}
                      </GlassPanel>
                    ))}
                  </div>
                  {view.priorities.length > view.initialPriorityCount && (
                    <Button
                      className="report-interactive mt-4"
                      variant="ghost"
                      data-testid="view-all-improvements"
                      aria-expanded={showAllPriorities}
                      onClick={() => {
                        setShowAllPriorities((v) => !v);
                        emitReportTelemetry("priority_expanded", {
                          applicationRequestId: applicationRequestId ?? undefined,
                        });
                      }}
                    >
                      {showAllPriorities ? "Show top priorities" : "View all improvements"}
                    </Button>
                  )}
                </section>
              )}

              <GameplayMoments
                moments={view.moments}
                filterCategories={view.momentFilterCategories}
                applicationRequestId={view.applicationRequestId}
                sourceMediaAvailable={view.sourceMedia.available}
                activeMomentId={activeMomentId}
                onSelectMoment={onSelectMoment}
              />

              {view.strategySections.length > 0 && (
                <section id="strategy" aria-labelledby="strategy-heading" data-testid="report-strategy">
                  <h2 id="strategy-heading" className="mb-3 font-headline-lg text-headline-lg uppercase text-on-surface">
                    Tactical and Strategic Review
                  </h2>
                  <div className="space-y-4">
                    {view.strategySections.map((section) => (
                      <GlassPanel key={section.id} className="space-y-2 p-5">
                        <h3 className="font-headline-md text-headline-md uppercase text-on-surface">
                          {section.title}
                        </h3>
                        <p className="font-body-md text-on-surface">
                          <span className="text-on-surface-variant">Observed: </span>
                          {section.observedPattern}
                        </p>
                        <p className="font-body-md text-on-surface-variant">
                          <span className="text-on-surface">Impact: </span>
                          {section.impact}
                        </p>
                        <p className="font-body-md text-on-surface">
                          <span className="text-on-surface-variant">Adjustment: </span>
                          {section.recommendedAdjustment}
                        </p>
                        <p className="font-body-md text-primary">
                          <span className="text-on-surface">Cue: </span>
                          {section.cue}
                        </p>
                        <p className="font-label-sm text-label-sm text-on-surface-variant">
                          {section.confidenceLabel}
                        </p>
                      </GlassPanel>
                    ))}
                  </div>
                </section>
              )}

              {view.positionCoaching && (
                <section id="position" aria-labelledby="position-heading" data-testid="report-position-coaching">
                  <h2 id="position-heading" className="mb-3 font-headline-lg text-headline-lg uppercase text-on-surface">
                    {view.positionCoaching.title}
                  </h2>
                  <div className="grid gap-4 md:grid-cols-3">
                    {view.positionCoaching.themes.map((theme) => (
                      <GlassPanel key={theme.title} className="space-y-2 p-4">
                        <h3 className="font-headline-md text-headline-md text-on-surface">{theme.title}</h3>
                        <p className="font-body-md text-on-surface-variant">{theme.detail}</p>
                      </GlassPanel>
                    ))}
                  </div>
                </section>
              )}

              {view.controls.length > 0 && (
                <section id="controls" aria-labelledby="controls-heading" data-testid="report-controls">
                  <h2 id="controls-heading" className="mb-3 font-headline-lg text-headline-lg uppercase text-on-surface">
                    Controls and Mechanics
                  </h2>
                  <div className="space-y-4">
                    {view.controls.map((control) => (
                      <GlassPanel key={control.id} className="space-y-3 p-5">
                        <h3 className="font-headline-md text-headline-md uppercase text-on-surface">
                          {control.mechanicName}
                        </h3>
                        <p className="font-label-sm text-label-sm uppercase text-on-surface-variant">
                          {control.platform.replace(/_/g, " ")} · {control.controlScheme.replace(/_/g, " ")}
                        </p>
                        <ControlBadges
                          steps={control.steps}
                          sequenceLabel={control.inputSequenceLabel}
                          ariaLabel={control.inputSequenceAria}
                        />
                        {control.whenToUse && (
                          <p className="font-body-md text-on-surface-variant">
                            <span className="text-on-surface">When to use: </span>
                            {control.whenToUse}
                          </p>
                        )}
                        {control.correctionCue && (
                          <p className="font-body-md text-primary">
                            <span className="text-on-surface">Cue: </span>
                            {control.correctionCue}
                          </p>
                        )}
                      </GlassPanel>
                    ))}
                  </div>
                </section>
              )}

              {view.faceoffs ? (
                <section id="faceoffs" aria-labelledby="faceoffs-heading" data-testid="report-faceoffs">
                  <h2 id="faceoffs-heading" className="mb-3 font-headline-lg text-headline-lg uppercase text-on-surface">
                    Faceoff Analysis
                  </h2>
                  <GlassPanel className="space-y-3 p-5">
                    <p className="font-body-md text-on-surface">
                      {view.faceoffs.wins} wins · {view.faceoffs.losses} losses · {view.faceoffs.faceoffCount}{" "}
                      draws
                      {view.faceoffs.winRateLabel ? ` · ${view.faceoffs.winRateLabel} win rate` : ""}
                    </p>
                    <p className="font-body-md text-on-surface-variant">
                      <span className="text-on-surface">Common setup: </span>
                      {view.faceoffs.commonSetup}
                    </p>
                    <p className="font-body-md text-on-surface-variant">
                      <span className="text-on-surface">Failure pattern: </span>
                      {view.faceoffs.failurePattern}
                    </p>
                    {view.faceoffs.timingIssue && (
                      <p className="font-body-md text-on-surface-variant">{view.faceoffs.timingIssue}</p>
                    )}
                    {view.faceoffs.counterRecommendation && (
                      <p className="font-body-md text-primary">{view.faceoffs.counterRecommendation}</p>
                    )}
                    <p className="font-label-sm text-label-sm text-on-surface-variant">
                      {view.faceoffs.confidenceLabel}
                    </p>
                  </GlassPanel>
                </section>
              ) : (
                <p className="sr-only" data-testid="report-faceoffs-omitted">
                  No faceoff situations were identified in this video.
                </p>
              )}

              <PracticePlan
                drills={view.practiceDrills}
                applicationRequestId={view.applicationRequestId}
              />

              <section id="next" aria-labelledby="next-heading" data-testid="report-next-game-focus">
                <h2 id="next-heading" className="mb-3 font-headline-lg text-headline-lg uppercase text-on-surface">
                  Your Next Game Focus
                </h2>
                <GlassPanel className="space-y-3 border-l-4 border-l-tertiary p-6">
                  <p className="font-body-md text-on-surface">
                    <span className="font-label-sm uppercase text-on-surface-variant">Primary focus</span>
                    <br />
                    {view.nextGameFocus.primaryFocus}
                  </p>
                  <p className="font-body-md text-on-surface">
                    <span className="font-label-sm uppercase text-on-surface-variant">Cue</span>
                    <br />
                    {view.nextGameFocus.supportingCue}
                  </p>
                  <p className="font-body-md text-on-surface">
                    <span className="font-label-sm uppercase text-on-surface-variant">
                      Success condition
                    </span>
                    <br />
                    {view.nextGameFocus.successCondition}
                  </p>
                </GlassPanel>
              </section>

              <section id="about" aria-labelledby="about-heading" data-testid="report-metadata">
                <h2 id="about-heading" className="mb-3 font-headline-lg text-headline-lg uppercase text-on-surface">
                  About This Analysis
                </h2>
                <GlassPanel className="space-y-2 p-5">
                  <p className="font-body-md text-on-surface-variant">
                    Report version {view.metadata.reportVersion} · Rubric {view.metadata.rubricVersion}
                  </p>
                  <p className="font-body-md text-on-surface-variant">
                    Strategy knowledge {view.metadata.strategyKnowledgeVersion} · Controls knowledge{" "}
                    {view.metadata.controlKnowledgeVersion}
                  </p>
                  <p className="font-body-md text-on-surface-variant">
                    Generated {new Date(view.metadata.generatedAt).toLocaleString()}
                  </p>
                  {view.limitations.length > 0 && (
                    <div className="pt-2" data-testid="report-limitations">
                      <p className="font-label-sm uppercase text-on-surface-variant">Limitations</p>
                      <ul className="mt-2 list-disc space-y-1 pl-5">
                        {view.limitations.map((item) => (
                          <li key={item} className="font-body-md text-on-surface-variant">
                            {item}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </GlassPanel>
              </section>

              <div className="report-interactive flex flex-wrap gap-3">
                {applicationRequestId && (
                  <Button
                    variant="ghost"
                    onClick={() => navigate(analysisStatusPath(applicationRequestId))}
                  >
                    Back to analysis status
                  </Button>
                )}
                <Button variant="ghost" onClick={() => navigate("/upload")}>
                  Analyze another video
                </Button>
              </div>
            </div>

            <aside
              className="report-summary-sidebar hidden lg:block"
              aria-label="Report summary"
              data-testid="report-summary-sidebar"
            >
              <div className="sticky top-24 space-y-4">
                <GlassPanel className="space-y-3 p-4">
                  <p className="font-label-sm uppercase text-on-surface-variant">At a glance</p>
                  <p className="font-body-md text-on-surface">
                    <span className="text-tertiary">Strength: </span>
                    {view.executive.strongestArea}
                  </p>
                  <p className="font-body-md text-on-surface">
                    <span className="text-error">Priority: </span>
                    {view.executive.highestPriority}
                  </p>
                  {view.header.videoDurationLabel && (
                    <p className="font-label-sm text-label-sm text-on-surface-variant">
                      Duration {view.header.videoDurationLabel}
                    </p>
                  )}
                  <p className="font-body-md text-on-surface-variant">{view.nextGameFocus.primaryFocus}</p>
                </GlassPanel>
              </div>
            </aside>
          </div>
        )}
      </main>
      <BottomNav active="film" />
    </div>
  );
}

function MetaItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-white/10 bg-surface-container/60 p-3">
      <dt className="font-label-sm text-label-sm uppercase text-on-surface-variant">{label}</dt>
      <dd className="mt-1 font-body-md text-on-surface">{value}</dd>
    </div>
  );
}

function SummaryTile({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: "good" | "bad" | "neutral";
}) {
  const border =
    tone === "good" ? "border-t-tertiary" : tone === "bad" ? "border-t-error" : "border-t-primary";
  return (
    <div className={`rounded-xl border border-white/10 border-t-2 ${border} bg-surface-container/40 p-4`}>
      <p className="font-label-sm uppercase text-on-surface-variant">{label}</p>
      <p className="mt-2 font-body-md text-on-surface">{value}</p>
    </div>
  );
}
