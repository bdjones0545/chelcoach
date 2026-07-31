/** Semantic control input badges with accessible text alternatives. */

export function ControlBadges({
  steps,
  sequenceLabel,
  ariaLabel,
}: {
  steps: { order: number; input: string; behavior: string }[];
  sequenceLabel: string;
  ariaLabel: string;
}) {
  if (steps.length === 0) {
    return <p className="font-body-md text-on-surface-variant">{sequenceLabel}</p>;
  }
  return (
    <div aria-label={ariaLabel} className="flex flex-wrap items-center gap-2">
      {steps.map((step, index) => (
        <span key={`${step.order}-${step.input}`} className="inline-flex items-center gap-2">
          {index > 0 && (
            <span className="font-label-sm text-on-surface-variant" aria-hidden="true">
              →
            </span>
          )}
          <span className="inline-flex items-center gap-1 rounded-lg border border-white/15 bg-surface-container-highest px-2 py-1 font-label-sm text-label-sm uppercase text-on-surface">
            <span className="sr-only">
              {step.behavior === "hold"
                ? "Hold "
                : step.behavior === "tap"
                  ? "Tap "
                  : step.behavior === "motion"
                    ? "Move "
                    : ""}
            </span>
            {step.behavior === "hold" && <span aria-hidden="true">Hold </span>}
            {step.input}
          </span>
        </span>
      ))}
      <span className="sr-only">{ariaLabel}</span>
    </div>
  );
}
