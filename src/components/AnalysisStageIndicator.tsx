/**
 * Stage-based analysis progress — confirmed stages only, no percentages (Step 7).
 */
import type { AnalysisStage } from "../lib/analysisStatusPresentation";

export default function AnalysisStageIndicator({ stages }: { stages: AnalysisStage[] }) {
  return (
    <ol
      className="flex flex-wrap items-center gap-2"
      aria-label="Analysis stages"
      data-testid="analysis-stage-indicator"
    >
      {stages.map((stage, index) => {
        const isCurrent = stage.state === "current";
        const isComplete = stage.state === "complete";
        const isFailed = stage.state === "failed";
        const isCancelled = stage.state === "cancelled";
        return (
          <li key={stage.id} className="flex items-center gap-2">
            {index > 0 && (
              <span className="text-on-surface-variant" aria-hidden="true">
                /
              </span>
            )}
            <span
              className={[
                "font-label-sm text-label-sm uppercase tracking-wide",
                isCurrent ? "text-primary" : "",
                isComplete ? "text-tertiary" : "",
                isFailed ? "text-error" : "",
                isCancelled ? "text-on-surface-variant" : "",
                !isCurrent && !isComplete && !isFailed && !isCancelled
                  ? "text-on-surface-variant"
                  : "",
              ].join(" ")}
              aria-current={isCurrent ? "step" : undefined}
              data-stage={stage.id}
              data-stage-state={stage.state}
            >
              {stage.label}
              <span className="sr-only">
                {isComplete
                  ? ", complete"
                  : isCurrent
                    ? ", current"
                    : isFailed
                      ? ", failed"
                      : isCancelled
                        ? ", cancelled"
                        : ", upcoming"}
              </span>
            </span>
          </li>
        );
      })}
    </ol>
  );
}
