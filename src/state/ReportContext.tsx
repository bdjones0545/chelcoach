import { createContext, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { mockReport, type GameReport } from "../data/mockData";
import { fetchBackendReport, USE_BACKEND_REPORTS } from "../lib/reportApi";

interface ReportState {
  /** The analysis report the UI renders. Mock by default; backend when the flag is on. */
  report: GameReport;
  source: "mock" | "api";
}

const ReportContext = createContext<ReportState | undefined>(undefined);

export function ReportProvider({ children }: { children: ReactNode }) {
  const [apiReport, setApiReport] = useState<GameReport | null>(null);

  useEffect(() => {
    if (!USE_BACKEND_REPORTS) return;
    const controller = new AbortController();
    fetchBackendReport(controller.signal)
      .then(setApiReport)
      .catch((err) => {
        // Graceful degradation: keep the (identical-content) mock report on any failure.
        if (!controller.signal.aborted) {
          console.warn("[ChelCoach] backend report unavailable, using mock:", err);
        }
      });
    return () => controller.abort();
  }, []);

  const value = useMemo<ReportState>(
    () => ({
      report: apiReport ?? mockReport,
      source: apiReport ? "api" : "mock",
    }),
    [apiReport],
  );

  return <ReportContext.Provider value={value}>{children}</ReportContext.Provider>;
}

// eslint-disable-next-line react-refresh/only-export-components
export function useReport(): ReportState {
  const ctx = useContext(ReportContext);
  if (!ctx) throw new Error("useReport must be used within a ReportProvider");
  return ctx;
}
