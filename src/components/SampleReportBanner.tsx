import { useNavigate } from "react-router-dom";
import Icon from "./Icon";

/**
 * Every screen in the public demo loop (/scorecard, /film-preview, /paywall, /film-room)
 * carries this so nobody mistakes the sample for their own analysis.
 */
export default function SampleReportBanner() {
  const navigate = useNavigate();
  return (
    <div
      role="note"
      data-testid="sample-report-banner"
      className="mb-6 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-secondary/40 bg-secondary/10 px-4 py-3"
    >
      <span className="flex items-center gap-2 font-label-md text-label-md text-on-surface">
        <Icon name="info" className="text-secondary" fill />
        Sample report — example content, not your gameplay.
      </span>
      <button
        type="button"
        onClick={() => navigate("/upload")}
        className="font-label-md text-label-md uppercase tracking-widest text-primary transition-colors hover:text-primary-container"
      >
        Analyze my own clip
      </button>
    </div>
  );
}
