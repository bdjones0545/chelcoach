import type { Metric } from "../data/mockData";
import { toneBar, toneGlow, toneText } from "./tone";
import GlassPanel from "./GlassPanel";
import Icon from "./Icon";

interface MetricCardProps {
  metric: Metric;
}

/** Single scorecard metric with an animated glowing progress bar. */
export default function MetricCard({ metric }: MetricCardProps) {
  return (
    <GlassPanel className="group p-6 transition-transform hover:-translate-y-0.5 hover:bg-white/5">
      <div className="mb-4 flex items-start justify-between">
        <Icon name={metric.icon} className={`text-[32px] ${toneText[metric.tone]}`} />
        <span className={`font-headline-md text-headline-md ${toneText[metric.tone]}`}>{metric.value}</span>
      </div>
      <h3 className="mb-2 font-headline-md text-headline-md text-white">{metric.label}</h3>
      <div className="h-1 w-full overflow-hidden rounded-full bg-white/5">
        <div
          className={`h-full ${toneBar[metric.tone]} ${toneGlow[metric.tone]}`}
          style={{ width: `${metric.value}%` }}
        />
      </div>
      <p className="mt-4 font-label-sm text-label-sm text-on-surface-variant">{metric.note}</p>
    </GlassPanel>
  );
}
