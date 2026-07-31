import type { ReportNavSectionId } from "../../lib/coachingReportView";

export default function ReportSectionNav({
  sections,
  activeId,
  onNavigate,
}: {
  sections: { id: ReportNavSectionId; label: string }[];
  activeId: ReportNavSectionId;
  onNavigate: (id: ReportNavSectionId) => void;
}) {
  return (
    <nav
      className="report-section-nav custom-scrollbar -mx-1 overflow-x-auto px-1"
      aria-label="Report sections"
      data-testid="report-section-nav"
    >
      <ul className="flex min-w-min gap-2 pb-2 md:flex-wrap">
        {sections.map((section) => {
          const active = section.id === activeId;
          return (
            <li key={section.id}>
              <button
                type="button"
                className={[
                  "whitespace-nowrap rounded-lg border px-3 py-2 font-label-sm text-label-sm uppercase tracking-wide transition-colors",
                  active
                    ? "border-primary bg-primary/10 text-primary"
                    : "border-white/10 text-on-surface-variant hover:border-white/20 hover:text-on-surface",
                ].join(" ")}
                aria-current={active ? "true" : undefined}
                onClick={() => onNavigate(section.id)}
              >
                {section.label}
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
