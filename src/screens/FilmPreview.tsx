import { useNavigate } from "react-router-dom";
import BottomNav from "../components/BottomNav";
import Button from "../components/Button";
import CoachingMomentCard from "../components/CoachingMomentCard";
import Icon from "../components/Icon";
import TopAppBar from "../components/TopAppBar";
import { usePremium } from "../state/PremiumContext";
import { useReport } from "../state/ReportContext";

export default function FilmPreview() {
  const navigate = useNavigate();
  const { isPremium } = usePremium();
  const { report } = useReport();
  const coachingMoments = report.coachingMoments;

  const goUnlock = () => (isPremium ? navigate("/film-room") : navigate("/paywall"));

  return (
    <div className="min-h-screen bg-background pb-32">
      <TopAppBar />

      <main className="mx-auto max-w-container-max px-4 pb-8 pt-24 md:px-margin-desktop">
        <div className="mb-12">
          <div className="mb-2 flex items-center gap-2">
            <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-primary" />
            <span className="font-label-sm text-label-sm uppercase tracking-widest text-primary">
              Locked Film Preview
            </span>
          </div>
          <h1 className="mb-4 font-headline-xl text-[32px] uppercase md:text-headline-xl">Coaching Moments</h1>
          <p className="max-w-2xl font-body-lg text-body-lg text-on-surface-variant">
            ChelCoach tagged <span className="font-bold text-on-surface">42 coaching moments</span> in this game.
            Here are three — one you nailed, and two that cost you. You can see what happened on each. The exact fix is
            one tap away.
          </p>
        </div>

        {/* Great play shown as a trust-building unlocked taste; the rest are locked. */}
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          {coachingMoments.map((moment, i) => (
            <div key={moment.id} className={i === 0 ? "lg:col-span-2" : ""}>
              <CoachingMomentCard moment={moment} locked={moment.type !== "great"} onUnlock={goUnlock} />
            </div>
          ))}
        </div>

        <section className="relative mt-16 overflow-hidden rounded-2xl border border-primary/20 bg-gradient-to-br from-surface-container-high to-surface-container-lowest p-8 text-center">
          <div className="pointer-events-none absolute -right-24 -top-24 h-64 w-64 rounded-full bg-primary/10 blur-3xl" />
          <div className="pointer-events-none absolute -bottom-24 -left-24 h-64 w-64 rounded-full bg-tertiary/5 blur-3xl" />
          <div className="relative z-10 flex flex-col items-center">
            <Icon name="lock_open" className="mb-3 text-4xl text-primary" />
            <h2 className="mb-4 font-headline-lg text-headline-lg-mobile md:text-headline-lg">
              See all 39 moments you're missing
            </h2>
            <p className="mx-auto mb-8 max-w-xl font-body-lg text-body-lg text-on-surface-variant">
              Unlock every tagged moment on the interactive timeline, the AI coach's read on each play, and a plan to
              fix your game before puck drop.
            </p>
            <Button className="group" trailingIcon="arrow_forward" onClick={goUnlock}>
              Unlock Complete Breakdown
            </Button>
          </div>
        </section>
      </main>

      <BottomNav active="insights" />
    </div>
  );
}
