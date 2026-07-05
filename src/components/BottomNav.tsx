import { useNavigate } from "react-router-dom";
import Icon from "./Icon";

type NavKey = "film" | "tactics" | "roster" | "insights";

interface NavItem {
  key: NavKey;
  label: string;
  icon: string;
  to: string;
}

const items: NavItem[] = [
  { key: "film", label: "Film Room", icon: "movie_filter", to: "/film-room" },
  { key: "tactics", label: "Tactics", icon: "strategy", to: "/scorecard" },
  { key: "roster", label: "Roster", icon: "groups", to: "/scorecard" },
  { key: "insights", label: "AI Insights", icon: "psychology", to: "/film-preview" },
];

interface BottomNavProps {
  active?: NavKey;
}

/** Mobile bottom navigation. Highlights the active destination as a pill. */
export default function BottomNav({ active = "film" }: BottomNavProps) {
  const navigate = useNavigate();

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
            onClick={() => navigate(item.to)}
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
