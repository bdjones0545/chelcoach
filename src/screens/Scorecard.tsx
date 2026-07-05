import { useNavigate } from "react-router-dom";
import BottomNav from "../components/BottomNav";
import Button from "../components/Button";
import GlassPanel from "../components/GlassPanel";
import Icon from "../components/Icon";
import MetricCard from "../components/MetricCard";
import StatePanel from "../components/StatePanel";
import TopAppBar from "../components/TopAppBar";
import { stateCopy } from "../data/mockData";
import { useReport } from "../state/ReportContext";

export default function Scorecard() {
  const navigate = useNavigate();
  const { report } = useReport();
  const { scorecard } = report;

  // Fallback state — analysis data is missing or incomplete.
  if (!scorecard || !scorecard.metrics?.length) {
    const copy = stateCopy.dataUnavailable;
    return (
      <div className="min-h-screen bg-surface-container-lowest pb-32">
        <TopAppBar />
        <main className="mx-auto flex max-w-container-max items-center justify-center px-4 pt-32 md:px-gutter">
          <StatePanel
            icon={copy.icon}
            tone={copy.tone}
            title={copy.title}
            message={copy.message}
            primary={{ label: copy.primaryLabel, onClick: () => navigate("/upload") }}
            secondary={{ label: "Back to Home", onClick: () => navigate("/") }}
          />
        </main>
        <BottomNav active="roster" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-surface-container-lowest pb-32">
      <TopAppBar />

      <main className="hex-bg relative mx-auto min-h-screen max-w-container-max overflow-hidden px-4 pb-8 pt-24 md:px-margin-desktop">
        <div className="pointer-events-none absolute right-0 top-0 -z-0 h-[600px] w-[600px] rounded-full bg-primary/5 blur-[120px]" />
        <div className="pointer-events-none absolute bottom-0 left-0 -z-0 h-[400px] w-[400px] rounded-full bg-tertiary/5 blur-[100px]" />

        {/* Header + rating */}
        <section className="relative mb-10 flex flex-col justify-between gap-6 text-center md:flex-row md:items-end md:text-left">
          <div>
            <div className="mb-4 inline-flex items-center gap-2 rounded-full border border-white/10 bg-surface-container-highest px-3 py-1">
              <Icon name="verified" className="text-[16px] text-tertiary" fill />
              <span className="font-label-sm text-label-sm text-tertiary">
                AI analyzed {scorecard.eventsAnalyzed}+ gameplay events
              </span>
            </div>
            <h1 className="mb-2 font-headline-xl text-[32px] uppercase text-white md:text-headline-xl">
              Your Chel Rating
            </h1>
            <p className="max-w-xl font-body-lg text-on-surface-variant">{scorecard.gameContext}</p>
          </div>

          <GlassPanel className="relative flex items-center justify-between gap-4 overflow-hidden border-l-4 border-l-primary p-6 shadow-2xl sm:gap-6">
            <div className="scanline" />
            <div className="flex flex-col">
              <span className="font-label-md text-label-md uppercase tracking-widest text-on-surface-variant">
                Chel Rating
              </span>
              <span className="font-headline-xl text-headline-xl leading-none text-primary">
                {scorecard.chelRating}
              </span>
              <span className="mt-1 font-label-md text-label-md text-tertiary">{scorecard.percentile}</span>
            </div>
            <div className="h-16 w-px shrink-0 bg-white/10" />
            <div className="flex flex-col items-center">
              <span className="font-label-md text-label-md uppercase tracking-widest text-on-surface-variant">
                Overall Grade
              </span>
              <span className="font-headline-xl text-headline-xl text-white">{scorecard.overallGrade}</span>
            </div>
          </GlassPanel>
        </section>

        {/* Metric grid */}
        <div className="mb-8 grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
          {scorecard.metrics.map((metric) => (
            <MetricCard key={metric.key} metric={metric} />
          ))}
        </div>

        {/* Strength / weakness */}
        <div className="mb-4 grid grid-cols-1 gap-6 md:grid-cols-2">
          <GlassPanel className="group relative flex items-center gap-6 overflow-hidden border-t-2 border-t-tertiary p-8">
            <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-lg bg-tertiary/10">
              <Icon name="trending_up" className="text-4xl text-tertiary" />
            </div>
            <div>
              <span className="font-label-sm text-label-sm uppercase tracking-tighter text-tertiary">
                Biggest Strength
              </span>
              <h4 className="font-headline-md text-headline-md text-white">{scorecard.biggestStrength.title}</h4>
              <p className="mt-2 font-body-md text-on-surface-variant">{scorecard.biggestStrength.detail}</p>
            </div>
          </GlassPanel>

          <GlassPanel className="group relative flex items-center gap-6 overflow-hidden border-t-2 border-t-error p-8">
            <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-lg bg-error/10">
              <Icon name="trending_down" className="text-4xl text-error" />
            </div>
            <div>
              <span className="font-label-sm text-label-sm uppercase tracking-tighter text-error">
                Biggest Weakness
              </span>
              <h4 className="font-headline-md text-headline-md text-white">{scorecard.biggestWeakness.title}</h4>
              <p className="mt-2 font-body-md text-on-surface-variant">{scorecard.biggestWeakness.detail}</p>
            </div>
          </GlassPanel>
        </div>

        {/* Conversion CTA */}
        <section className="relative mt-12 overflow-hidden rounded-2xl border border-primary/20 bg-gradient-to-br from-primary-container/20 to-surface-container-highest p-8 text-center md:p-10">
          <div className="relative z-10 flex flex-col items-center">
            <h2 className="mb-4 font-headline-lg text-headline-lg-mobile uppercase italic text-white md:text-headline-lg">
              The rating is free. The fixes are in the film.
            </h2>
            <p className="mx-auto mb-8 max-w-2xl font-body-lg text-on-surface-variant">
              ChelCoach tagged 42 coaching moments in this game — including the four high-danger chances your
              defensive positioning gave up. Unlock the full film to see each one on tape, with the exact adjustment.
            </p>
            <div className="flex flex-col items-center gap-4 sm:flex-row">
              <Button className="group" trailingIcon="arrow_forward" onClick={() => navigate("/paywall")}>
                Unlock Full Film Breakdown
              </Button>
              <Button variant="ghost" onClick={() => navigate("/film-preview")}>
                Preview Coaching Moments
              </Button>
            </div>
            <p className="mt-5 font-label-sm text-label-sm text-on-surface-variant">
              Your Chel Rating and scorecard stay free, forever.
            </p>
          </div>
        </section>
      </main>

      <BottomNav active="roster" />
    </div>
  );
}
