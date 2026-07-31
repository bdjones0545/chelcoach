import type { ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import BottomNav from "../components/BottomNav";
import GlassPanel from "../components/GlassPanel";
import Icon from "../components/Icon";
import StatePanel from "../components/StatePanel";
import TopAppBar from "../components/TopAppBar";
import { stateCopy } from "../data/mockData";
import { toneBar, toneText } from "../components/tone";
import { usePremium } from "../state/PremiumContext";
import { useAnalysis } from "../state/AnalysisContext";
import { useReport } from "../state/ReportContext";

/** Shared chrome (top bar + bottom nav) for the film room's empty / error states. */
function FilmRoomStateLayout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-background pb-32">
      <TopAppBar />
      <main className="mx-auto flex max-w-container-max items-center justify-center px-4 pt-32 md:px-gutter">
        {children}
      </main>
      <BottomNav active="film" />
    </div>
  );
}

export default function FilmRoom() {
  const { isPremium } = usePremium();
  const { hasAnalysis, markAnalyzed, setActiveClipId } = useAnalysis();
  const { report, restoreDemoReport } = useReport();
  const filmRoom = report.filmRoom;
  const navigate = useNavigate();

  // Empty state — the user hasn't analyzed a game yet.
  if (!hasAnalysis) {
    const copy = stateCopy.filmRoomEmpty;
    return (
      <FilmRoomStateLayout>
        <StatePanel
          icon={copy.icon}
          tone={copy.tone}
          title={copy.title}
          message={copy.message}
          primary={{ label: copy.primaryLabel, onClick: () => navigate("/upload") }}
          secondary={{
            label: copy.secondaryLabel,
            onClick: () => {
              setActiveClipId(null);
              restoreDemoReport();
              markAnalyzed();
              navigate("/scorecard");
            },
          }}
        />
      </FilmRoomStateLayout>
    );
  }

  // Fallback state — analysis exists but the report data is missing/incomplete.
  if (!filmRoom || !filmRoom.markers?.length) {
    const copy = stateCopy.dataUnavailable;
    return (
      <FilmRoomStateLayout>
        <StatePanel
          icon={copy.icon}
          tone={copy.tone}
          title={copy.title}
          message={copy.message}
          primary={{ label: copy.primaryLabel, onClick: () => navigate("/upload") }}
          secondary={{ label: copy.secondaryLabel, onClick: () => navigate("/scorecard") }}
        />
      </FilmRoomStateLayout>
    );
  }

  return (
    <div className="min-h-screen bg-background pb-32">
      <TopAppBar
        actions={
          <span className="hidden font-label-md text-label-md text-on-surface-variant md:block">
            {filmRoom.matchup}
          </span>
        }
      />

      <main className="mx-auto max-w-container-max px-4 pt-20 md:px-gutter">
        <div className="mb-6 mt-6 flex flex-wrap items-center gap-3">
          <h1 className="font-headline-xl text-[32px] uppercase md:text-headline-xl">Full Film Room</h1>
          <span
            className={`rounded-full px-3 py-1 font-label-sm text-label-sm uppercase tracking-widest ${
              isPremium
                ? "bg-tertiary-container text-on-tertiary-container"
                : "bg-surface-container-highest text-on-surface-variant"
            }`}
          >
            {isPremium ? "Premium Active" : "Demo"}
          </span>
        </div>

        {/* Video player placeholder */}
        <section className="group relative aspect-video overflow-hidden rounded-xl border border-white/10 bg-black shadow-2xl">
          <img src={filmRoom.videoPoster} alt="Game film" className="h-full w-full object-cover opacity-80" />
          <div className="absolute inset-0 bg-gradient-to-t from-surface-dim/80 via-transparent to-transparent" />
          <div className="absolute bottom-0 left-0 flex w-full flex-col gap-4 p-6">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-4">
                <button
                  type="button"
                  aria-label={`Play clip — ${filmRoom.clipLabel}`}
                  className="flex h-12 w-12 items-center justify-center rounded-full bg-primary text-on-primary transition-transform active:scale-90"
                >
                  <Icon name="play_arrow" fill />
                </button>
                <div className="flex flex-col">
                  <span className="font-label-md text-label-md font-bold text-white">{filmRoom.clipLabel}</span>
                  <span className="text-[10px] uppercase tracking-widest text-on-surface-variant">
                    {filmRoom.clipPhase}
                  </span>
                </div>
              </div>
              <div className="flex items-center gap-3 text-white">
                <button type="button" aria-label="Draw on clip" className="flex h-10 w-10 items-center justify-center rounded-lg transition-colors hover:bg-white/10">
                  <Icon name="draw" />
                </button>
                <button type="button" aria-label="Slow motion" className="flex h-10 w-10 items-center justify-center rounded-lg transition-colors hover:bg-white/10">
                  <Icon name="slow_motion_video" />
                </button>
                <button type="button" aria-label="Fullscreen" className="flex h-10 w-10 items-center justify-center rounded-lg transition-colors hover:bg-white/10">
                  <Icon name="fullscreen" />
                </button>
              </div>
            </div>
          </div>
        </section>

        {/* Interactive timeline */}
        <GlassPanel className="mb-8 mt-4 p-4">
          <div className="mb-4 flex items-center justify-between">
            <h3 className="flex items-center gap-2 font-label-md text-label-md text-primary">
              <Icon name="history" className="text-[18px]" />
              Playback Timeline
            </h3>
            <div className="flex gap-4">
              {[
                ["bg-tertiary", "Great"],
                ["bg-primary-container", "Neutral"],
                ["bg-error", "Mistake"],
              ].map(([dot, label]) => (
                <div key={label} className="flex items-center gap-1">
                  <div className={`h-2 w-2 rounded-full ${dot}`} />
                  <span className="text-[10px] font-label-sm text-on-surface-variant">{label}</span>
                </div>
              ))}
            </div>
          </div>
          <div className="group relative flex h-12 w-full cursor-pointer items-center">
            <div className="absolute h-1 w-full rounded-full bg-white/10" />
            <div className="absolute h-1 w-1/3 rounded-full bg-primary" />
            <div className="absolute left-1/3 z-10 h-8 w-0.5 bg-primary" />
            {filmRoom.markers.map((marker) => (
              <div
                key={marker.position}
                className="timeline-marker group/marker absolute -translate-x-1/2"
                style={{ left: `${marker.position}%` }}
                title={`${marker.timestamp} — ${marker.label}`}
              >
                <div
                  className={`h-4 w-4 rounded-full border-2 border-surface-dim ${toneBar[marker.tone]}`}
                />
                <span className="pointer-events-none absolute bottom-6 left-1/2 hidden -translate-x-1/2 whitespace-nowrap rounded bg-surface-container-highest px-2 py-1 font-label-sm text-label-sm text-on-surface group-hover/marker:block">
                  {marker.timestamp} · {marker.label}
                </span>
              </div>
            ))}
          </div>
        </GlassPanel>

        {/* Analysis grid */}
        <div className="grid grid-cols-1 items-start gap-6 md:grid-cols-12">
          {/* Left column */}
          <div className="flex flex-col gap-6 md:col-span-8">
            {/* AI Coach commentary + strengths/mistakes */}
            <GlassPanel className="relative overflow-hidden p-6">
              <div className="absolute left-0 top-0 h-full w-1 bg-primary" />
              <div className="mb-4 flex items-start justify-between">
                <div>
                  <h2 className="mb-1 font-headline-md text-headline-md text-primary">AI Coach Commentary</h2>
                  <p className="font-body-md italic text-on-surface-variant opacity-80">“{filmRoom.commentary}”</p>
                </div>
                <Icon name="psychology" className="text-4xl text-primary-container" fill />
              </div>
              <div className="mt-8 grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div className="rounded-lg border border-white/5 bg-surface-container-low p-4">
                  <div className="mb-2 flex items-center gap-2">
                    <Icon name="check_circle" className="text-tertiary" />
                    <h4 className="font-label-md text-label-md text-tertiary">TOP 3 STRENGTHS</h4>
                  </div>
                  <ul className="space-y-2 text-sm text-on-surface-variant">
                    {filmRoom.strengths.map((s) => (
                      <li key={s} className="flex gap-2">
                        <span>•</span> {s}
                      </li>
                    ))}
                  </ul>
                </div>
                <div className="rounded-lg border border-white/5 bg-surface-container-low p-4">
                  <div className="mb-2 flex items-center gap-2">
                    <Icon name="warning" className="text-error" />
                    <h4 className="font-label-md text-label-md text-error">TOP 3 MISTAKES</h4>
                  </div>
                  <ul className="space-y-2 text-sm text-on-surface-variant">
                    {filmRoom.mistakes.map((m) => (
                      <li key={m} className="flex gap-2">
                        <span>•</span> {m}
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            </GlassPanel>

            {/* Highest impact adjustment */}
            <GlassPanel className="relative overflow-hidden border-l-4 border-l-primary p-6">
              <span className="font-label-sm text-label-sm uppercase tracking-widest text-primary">
                Highest Impact Adjustment
              </span>
              <h3 className="mt-1 font-headline-md text-headline-md text-white">
                {filmRoom.highestImpactAdjustment.title}
              </h3>
              <p className="mt-2 font-body-md text-on-surface-variant">
                {filmRoom.highestImpactAdjustment.detail}
              </p>
            </GlassPanel>

            {/* Impact meters */}
            <GlassPanel className="p-6">
              <h3 className="mb-4 border-b border-white/10 pb-2 font-label-md text-label-md uppercase tracking-widest text-on-surface">
                Impact Rating
              </h3>
              <div className="space-y-6">
                {filmRoom.impactMeters.map((meter) => (
                  <div key={meter.label} className="flex items-center justify-between gap-4">
                    <div className="flex flex-col">
                      <span className="font-medium text-on-surface">{meter.label}</span>
                      <span className="text-xs text-on-surface-variant">{meter.detail}</span>
                    </div>
                    <div className="flex items-center gap-4">
                      <div className="h-2 w-24 overflow-hidden rounded-full bg-white/5 sm:w-32">
                        <div className={`h-full ${toneBar[meter.tone]}`} style={{ width: `${meter.value}%` }} />
                      </div>
                      <span className={`font-label-md text-label-md ${toneText[meter.tone]}`}>{meter.score}</span>
                    </div>
                  </div>
                ))}
              </div>
            </GlassPanel>
          </div>

          {/* Right column */}
          <div className="flex flex-col gap-6 md:col-span-4">
            {/* Next game focus */}
            <GlassPanel className="border-primary/20 bg-primary-container/10 p-6">
              <h3 className="mb-2 flex items-center gap-2 font-label-md text-label-md text-primary">
                <Icon name="flag" />
                NEXT GAME FOCUS
              </h3>
              <p className="font-body-md text-on-surface">{filmRoom.nextGameFocus}</p>
            </GlassPanel>

            {/* Weekly skill focus */}
            <GlassPanel className="p-6">
              <h3 className="mb-4 flex items-center gap-2 font-label-md text-label-md text-primary">
                <Icon name="rocket_launch" />
                WEEKLY SKILL FOCUS
              </h3>
              <div className="space-y-4">
                {filmRoom.weeklySkillFocus.map((item) => (
                  <div key={item.title} className="rounded-lg border border-white/10 bg-black/40 p-3">
                    <p className="mb-1 text-sm font-medium text-on-surface">{item.title}</p>
                    <p className="text-[11px] leading-relaxed text-on-surface-variant">{item.detail}</p>
                  </div>
                ))}
                <button className="mt-2 flex w-full items-center justify-center gap-2 rounded-lg bg-primary py-3 font-label-md text-label-md text-on-primary transition-transform active:scale-95">
                  <Icon name="calendar_today" className="text-[18px]" />
                  ADD TO PRACTICE SCHEDULE
                </button>
              </div>
            </GlassPanel>

            {/* Game summary */}
            <GlassPanel className="p-6">
              <h3 className="mb-4 font-label-md text-label-md text-on-surface-variant">GAME SUMMARY</h3>
              <div className="space-y-3">
                {filmRoom.gameSummary.map((row, i, arr) => (
                  <div
                    key={row.label}
                    className={`flex items-center justify-between text-sm ${
                      i < arr.length - 1 ? "border-b border-white/5 pb-2" : ""
                    }`}
                  >
                    <span className="text-on-surface-variant">{row.label}</span>
                    <span className="font-label-sm text-on-surface">{row.value}</span>
                  </div>
                ))}
              </div>
            </GlassPanel>
          </div>
        </div>
      </main>

      <BottomNav active="film" />
    </div>
  );
}
