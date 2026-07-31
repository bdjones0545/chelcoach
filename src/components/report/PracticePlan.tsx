import { useState } from "react";
import GlassPanel from "../GlassPanel";
import { ControlBadges } from "./ControlBadges";
import type { DrillCompletionState, PracticeDrillView } from "../../lib/coachingReportView";
import { emitReportTelemetry } from "../../lib/reportTelemetry";

const STATES: { value: DrillCompletionState; label: string }[] = [
  { value: "not_started", label: "Not started" },
  { value: "in_progress", label: "In progress" },
  { value: "completed", label: "Completed" },
];

export default function PracticePlan({
  drills,
  applicationRequestId,
}: {
  drills: PracticeDrillView[];
  applicationRequestId: string;
}) {
  const [states, setStates] = useState<Record<string, DrillCompletionState>>({});

  if (drills.length === 0) return null;

  return (
    <section id="practice" aria-labelledby="practice-heading" data-testid="report-practice-plan">
      <h2 id="practice-heading" className="mb-2 font-headline-lg text-headline-lg uppercase text-on-surface">
        Your Practice Plan
      </h2>
      <p className="mb-4 font-body-md text-on-surface-variant">
        Up to three focused drills. Completion tracking below is presentation-only and is not saved to
        your account.
      </p>
      <div className="space-y-4">
        {drills.map(({ drill, whySelected, controlLabel }) => {
          const state = states[drill.drillId] ?? "not_started";
          return (
            <article key={drill.drillId}>
              <GlassPanel className="space-y-3 border-t-2 border-t-primary p-5">
                <h3 className="font-headline-md text-headline-md uppercase text-on-surface">{drill.name}</h3>
                <p className="font-body-md text-on-surface">
                  <span className="text-on-surface-variant">Objective: </span>
                  {drill.objective}
                </p>
                <p className="font-body-md text-on-surface-variant">{whySelected}</p>
                <p className="font-body-md text-on-surface-variant">
                  <span className="text-on-surface">Setup: </span>
                  {drill.setup}
                </p>
                {drill.verifiedControlInputs.length > 0 ? (
                  <ControlBadges
                    steps={drill.verifiedControlInputs.map((s) => ({
                      order: s.order,
                      input: s.input,
                      behavior: s.behavior,
                    }))}
                    sequenceLabel={controlLabel}
                    ariaLabel={`Verified inputs: ${controlLabel}`}
                  />
                ) : (
                  <p className="font-body-md text-on-surface-variant">Mechanics: {drill.requiredMechanics.join(", ")}</p>
                )}
                <p className="font-body-md text-on-surface-variant">
                  <span className="text-on-surface">Reps: </span>
                  {drill.repetitionTarget}
                </p>
                <p className="font-body-md text-on-surface-variant">
                  <span className="text-on-surface">Success: </span>
                  {drill.successCriteria}
                </p>
                {drill.commonErrors[0] && (
                  <p className="font-body-md text-on-surface-variant">
                    <span className="text-on-surface">Common error: </span>
                    {drill.commonErrors[0]}
                  </p>
                )}
                {drill.progression && (
                  <p className="font-body-md text-on-surface-variant">
                    <span className="text-on-surface">Progression: </span>
                    {drill.progression}
                  </p>
                )}
                <div className="report-interactive">
                  <p className="mb-2 font-label-sm uppercase text-on-surface-variant">
                    Drill status (local only)
                  </p>
                  <div className="flex flex-wrap gap-2" role="group" aria-label={`Status for ${drill.name}`}>
                    {STATES.map((option) => (
                      <button
                        key={option.value}
                        type="button"
                        className={[
                          "rounded-lg border px-3 py-1.5 font-label-sm text-label-sm",
                          state === option.value
                            ? "border-primary bg-primary/10 text-primary"
                            : "border-white/10 text-on-surface-variant",
                        ].join(" ")}
                        aria-pressed={state === option.value}
                        onClick={() => {
                          setStates((prev) => ({ ...prev, [drill.drillId]: option.value }));
                          emitReportTelemetry("drill_state_changed", {
                            applicationRequestId,
                            drillId: drill.drillId,
                            state: option.value,
                          });
                        }}
                      >
                        {option.label}
                      </button>
                    ))}
                  </div>
                </div>
              </GlassPanel>
            </article>
          );
        })}
      </div>
    </section>
  );
}
