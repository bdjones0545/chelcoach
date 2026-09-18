import { useNavigate } from "react-router-dom";
import { analysisStatusPath } from "../lib/analysisRequestId";
import { useAnalysis } from "../state/AnalysisContext";
import Icon from "./Icon";

/** Only screens that exist. The old Tactics / Roster / AI Insights tabs pointed into the demo. */
type NavKey = "upload" | "analysis" | "sample";

interface NavItem {
  key: NavKey;
  label: string;
  icon: string;
  to: (currentAnalysisId: string | null) => string;
}

const items: NavItem[] = [
  { key: "upload", label: "Upload", icon: "cloud_upload", to: () => "/upload" },
  {
    key: "analysis",
    label: "Analysis",
    icon: "query_stats",
    // The analysis this tab is working on; otherwise the status screen explains there is none yet.
    to: (id) => (id ? analysisStatusPath(id) : "/analysis-status"),
  },
  { key: "sample", label: "Sample report", icon: "movie_filter", to: () => "/scorecard" },
];

interface BottomNavProps {
  active?: NavKey;
}

/** Mobile bottom navigation. Highlights the active destination as a pill. */
export default function BottomNav({ active = "upload" }: BottomNavProps) {
  const navigate = useNavigate();
  const { currentAnalysisId } = useAnalysis();

  return (
    <nav
      aria-label="Primary"
      className="fixed bottom-0 left-0 z-50 flex h-20 w-full items-center justify-around border-t border-white/5 bg-surface-container-lowest/90 px-2 pb-safe shadow-2xl backdrop-blur-lg"
    >
      {items.map((item) => {
        const isActive = item.key === active;
        return (
          <button
            key={item.key}
            type="button"
            onClick={() => navigate(item.to(currentAnalysisId))}
            aria-current={isActive ? "page" : undefined}
            className={`flex min-h-[52px] min-w-[64px] flex-col items-center justify-center gap-0.5 rounded-full px-3 py-1 duration-150 active:scale-90 ${
              isActive
                ? "bg-primary-container text-on-primary-container"
                : "text-on-surface-variant transition-colors hover:text-primary"
            }`}
          >
            <Icon name={item.icon} fill={isActive} />
            <span className="font-label-sm text-label-sm">{item.label}</span>
          </button>
        );
      })}
    </nav>
  );
}
