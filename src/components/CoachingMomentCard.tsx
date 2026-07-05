import type { CoachingMoment } from "../data/mockData";
import { momentStyles } from "./tone";
import GlassPanel from "./GlassPanel";
import Icon from "./Icon";

interface CoachingMomentCardProps {
  moment: CoachingMoment;
  /** When true, the full breakdown is hidden behind a premium blur overlay. */
  locked?: boolean;
  onUnlock?: () => void;
}

export default function CoachingMomentCard({ moment, locked = true, onUnlock }: CoachingMomentCardProps) {
  const style = momentStyles[moment.type];

  return (
    <GlassPanel className="group flex flex-col overflow-hidden transition-transform hover:-translate-y-1">
      {/* Thumbnail / video placeholder */}
      <div className="relative h-52 overflow-hidden">
        <img
          src={moment.thumbnail}
          alt={moment.title}
          className="h-full w-full object-cover transition-transform duration-700 group-hover:scale-105"
        />
        <div className="absolute inset-0 bg-gradient-to-t from-surface-dim/80 to-transparent" />
        <span
          className={`absolute left-4 top-4 rounded-full px-3 py-1 font-label-sm text-label-sm uppercase tracking-tighter ${style.chip}`}
        >
          {moment.label}
        </span>
        <span className="absolute bottom-4 left-4 rounded bg-black/60 px-2 py-1 font-label-sm text-label-sm text-white backdrop-blur">
          {moment.timestamp} | {moment.period}
        </span>
        {moment.type === "missed" && <div className="scanline" />}
        <div className="absolute inset-0 flex items-center justify-center opacity-0 transition-opacity group-hover:opacity-100">
          <div className="flex h-16 w-16 items-center justify-center rounded-full border border-primary/40 bg-primary/20 backdrop-blur-md">
            <Icon name="play_arrow" className="text-3xl text-white" />
          </div>
        </div>
      </div>

      {/* Body */}
      <div className="relative flex flex-1 flex-col p-6">
        <div className="mb-2 flex items-start justify-between gap-3">
          <div>
            <span className="font-label-sm text-label-sm text-on-surface-variant">
              {moment.timestamp} — {moment.title}
            </span>
            <h3 className="mt-1 font-headline-md text-headline-md text-white">{moment.title}</h3>
          </div>
          <Icon name={moment.type === "great" ? "verified" : "sports_hockey"} className={style.chip.split(" ")[1]} />
        </div>
        <p className="font-body-md text-on-surface-variant">{moment.teaser}</p>

        {/* Full breakdown — locked or revealed */}
        <div className="relative mt-6">
          <div className={`border-t border-white/5 pt-4 ${locked ? "select-none blur-sm" : ""}`}>
            <div className="mb-1 flex items-center gap-2 font-label-md text-label-md text-primary">
              <Icon name="psychology" className="text-sm" />
              <span className="uppercase tracking-tighter">Coaching Insight</span>
            </div>
            <p className="font-body-md text-on-surface-variant">{moment.fullBreakdown}</p>
          </div>

          {locked && (
            <div className="premium-blur absolute inset-0 flex flex-col items-center justify-center gap-2 rounded-lg p-4 text-center">
              <Icon name="lock" className="text-primary" />
              <button
                onClick={onUnlock}
                className="rounded-full bg-primary px-6 py-2 font-label-md text-label-md uppercase tracking-tighter text-on-primary shadow-lg shadow-primary/20 transition-colors hover:bg-primary-container active:scale-95"
              >
                Unlock Full AI Analysis
              </button>
            </div>
          )}
        </div>
      </div>
    </GlassPanel>
  );
}
