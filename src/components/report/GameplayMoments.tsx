import { useMemo, useState } from "react";
import GlassPanel from "../GlassPanel";
import {
  formatMomentTimestamp,
  momentFilterLabel,
  type CoachingMomentView,
  type MomentFilterCategory,
} from "../../lib/coachingReportView";
import { emitReportTelemetry } from "../../lib/reportTelemetry";

export default function GameplayMoments({
  moments,
  filterCategories,
  applicationRequestId,
  sourceMediaAvailable,
  activeMomentId,
  onSelectMoment,
}: {
  moments: CoachingMomentView[];
  filterCategories: MomentFilterCategory[];
  applicationRequestId: string;
  sourceMediaAvailable: boolean;
  activeMomentId: string | null;
  onSelectMoment: (moment: CoachingMomentView) => void;
}) {
  const [filter, setFilter] = useState<MomentFilterCategory>("all");
  const visible = useMemo(
    () => (filter === "all" ? moments : moments.filter((m) => m.filterCategory === filter)),
    [filter, moments],
  );

  if (moments.length === 0) return null;

  return (
    <section id="moments" aria-labelledby="moments-heading" data-testid="report-gameplay-moments">
      <h2 id="moments-heading" className="mb-3 font-headline-lg text-headline-lg uppercase text-on-surface">
        Key Gameplay Moments
      </h2>
      <div className="mb-4 flex flex-wrap gap-2" role="group" aria-label="Filter gameplay moments">
        {filterCategories.map((cat) => (
          <button
            key={cat}
            type="button"
            className={[
              "rounded-lg border px-3 py-1.5 font-label-sm text-label-sm uppercase",
              filter === cat
                ? "border-primary bg-primary/10 text-primary"
                : "border-white/10 text-on-surface-variant",
            ].join(" ")}
            aria-pressed={filter === cat}
            onClick={() => setFilter(cat)}
          >
            {momentFilterLabel(cat)}
          </button>
        ))}
      </div>

      {!sourceMediaAvailable && (
        <p className="mb-4 font-body-md text-on-surface-variant">
          The source video is no longer available, but the coaching observations and timestamps remain
          saved.
        </p>
      )}

      <div className="space-y-3">
        {visible.map((moment) => {
          const selected = activeMomentId === moment.id;
          return (
            <article key={moment.id}>
              <GlassPanel
                className={[
                  "space-y-3 border-l-4 p-4",
                  moment.severity === "good_decision"
                    ? "border-l-tertiary"
                    : moment.severity === "key_mistake"
                      ? "border-l-error"
                      : moment.severity === "improvement_opportunity"
                        ? "border-l-primary"
                        : "border-l-outline",
                  selected ? "ring-1 ring-primary/40" : "",
                ].join(" ")}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    className="rounded-lg border border-white/15 bg-surface-container-highest px-3 py-1 font-label-sm text-label-sm text-primary"
                    aria-label={
                      moment.timestampSec != null
                        ? `Jump to gameplay moment at ${formatMomentTimestamp(moment.timestampSec)} — ${moment.observedAction}`
                        : `Select gameplay moment — ${moment.observedAction}`
                    }
                    aria-pressed={selected}
                    data-testid={`moment-timestamp-${moment.id}`}
                    onClick={() => {
                      onSelectMoment(moment);
                      emitReportTelemetry("evidence_timestamp_selected", {
                        applicationRequestId,
                        timestampSec: moment.timestampSec ?? undefined,
                      });
                    }}
                  >
                    {formatMomentTimestamp(moment.timestampSec)}
                  </button>
                  <span className="rounded-full border border-white/10 px-2 py-0.5 font-label-sm text-label-sm uppercase text-on-surface-variant">
                    {moment.severityLabel}
                  </span>
                  <span className="font-label-sm text-label-sm uppercase text-on-surface-variant">
                    {moment.category.replace(/_/g, " ")}
                  </span>
                </div>
                <h3 className="font-headline-md text-headline-md text-on-surface">{moment.observedAction}</h3>
                <p className="font-body-md text-on-surface-variant">
                  <span className="text-on-surface">What happened: </span>
                  {moment.why}
                </p>
                <p className="font-body-md text-on-surface-variant">
                  <span className="text-on-surface">Coaching takeaway: </span>
                  {moment.takeaway}
                </p>
                <p className="font-label-sm text-label-sm text-on-surface-variant">{moment.confidenceLabel}</p>
              </GlassPanel>
            </article>
          );
        })}
      </div>
    </section>
  );
}
