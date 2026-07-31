import GlassPanel from "../GlassPanel";

export default function ReportSkeleton() {
  return (
    <div className="space-y-4" data-testid="report-loading-skeleton" aria-busy="true">
      <p className="font-body-md text-on-surface">Loading your coaching report…</p>
      {Array.from({ length: 5 }).map((_, i) => (
        <GlassPanel key={i} className="space-y-3 p-6">
          <div className="h-4 w-32 animate-pulse rounded bg-white/10" />
          <div className="h-8 w-2/3 animate-pulse rounded bg-white/10" />
          <div className="h-4 w-full animate-pulse rounded bg-white/5" />
          <div className="h-4 w-5/6 animate-pulse rounded bg-white/5" />
        </GlassPanel>
      ))}
    </div>
  );
}
