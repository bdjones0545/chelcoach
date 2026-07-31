import { createContext, useCallback, useContext, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { mockReport, type GameReport } from "../data/mockData";
import { uploadClip, USE_BACKEND_REPORTS } from "../lib/reportApi";

/**
 * Report source — intentional and never confused:
 *   "demo" — local mockReport (flag off, or explicit demo actions)
 *   "live" — report fetched from the backend after a completed job
 */
export type ReportSource = "demo" | "live";

interface ReportState {
  report: GameReport;
  source: ReportSource;
  /** True when the backend feature flag is on. */
  backendEnabled: boolean;
  /**
   * Upload a real clip (flag on). Returns the new clipId.
   * Does not poll or fetch the report — Processing owns that.
   * No-op / throws when the flag is off.
   */
  uploadForAnalysis: (file: File, onProgress?: (percent: number) => void) => Promise<string>;
  /** Install a live backend report (only after status === completed). */
  acceptLiveReport: (report: GameReport) => void;
  /** Revert to the intentional demo report (e.g. start over). */
  restoreDemoReport: () => void;
}

const ReportContext = createContext<ReportState | undefined>(undefined);

export function ReportProvider({ children }: { children: ReactNode }) {
  const [liveReport, setLiveReport] = useState<GameReport | null>(null);

  const uploadForAnalysis = useCallback(async (file: File, onProgress?: (percent: number) => void) => {
    if (!USE_BACKEND_REPORTS) {
      throw new Error("Backend reports are disabled.");
    }
    return uploadClip(file, onProgress);
  }, []);

  const acceptLiveReport = useCallback((report: GameReport) => {
    setLiveReport(report);
  }, []);

  const restoreDemoReport = useCallback(() => {
    setLiveReport(null);
  }, []);

  const value = useMemo<ReportState>(
    () => ({
      // Live report only when explicitly accepted after a completed job.
      // Otherwise the intentional demo/mock report — never a silent stand-in for failure.
      report: liveReport ?? mockReport,
      source: liveReport ? "live" : "demo",
      backendEnabled: USE_BACKEND_REPORTS,
      uploadForAnalysis,
      acceptLiveReport,
      restoreDemoReport,
    }),
    [liveReport, uploadForAnalysis, acceptLiveReport, restoreDemoReport],
  );

  return <ReportContext.Provider value={value}>{children}</ReportContext.Provider>;
}

// eslint-disable-next-line react-refresh/only-export-components
export function useReport(): ReportState {
  const ctx = useContext(ReportContext);
  if (!ctx) throw new Error("useReport must be used within a ReportProvider");
  return ctx;
}
