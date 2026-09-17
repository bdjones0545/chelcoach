import { createContext, useContext, useMemo } from "react";
import type { ReactNode } from "react";
import { mockReport, type GameReport } from "../data/mockData";

interface ReportState {
  /**
   * The sample report behind the public demo loop (/scorecard, /film-preview, /film-room).
   * Real analyses never pass through here — they render from /analysis/:id/report.
   */
  report: GameReport;
  source: "sample";
}

const ReportContext = createContext<ReportState | undefined>(undefined);

export function ReportProvider({ children }: { children: ReactNode }) {
  const value = useMemo<ReportState>(() => ({ report: mockReport, source: "sample" }), []);
  return <ReportContext.Provider value={value}>{children}</ReportContext.Provider>;
}

// eslint-disable-next-line react-refresh/only-export-components
export function useReport(): ReportState {
  const ctx = useContext(ReportContext);
  if (!ctx) throw new Error("useReport must be used within a ReportProvider");
  return ctx;
}
