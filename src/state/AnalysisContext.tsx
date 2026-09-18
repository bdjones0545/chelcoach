import { createContext, useContext, useMemo, useState } from "react";
import type { ReactNode } from "react";

interface AnalysisState {
  /** Whether the sample analysis has been "viewed" in this session (demo loop only, in-memory). */
  hasAnalysis: boolean;
  markAnalyzed: () => void;
  reset: () => void;
  /**
   * The real analysis this tab is working on, so the bottom nav can return to it. In memory on
   * purpose: the analysis screens persist nothing, and /analysis/:id is the recovery key.
   */
  currentAnalysisId: string | null;
  setCurrentAnalysisId: (id: string | null) => void;
}

const AnalysisContext = createContext<AnalysisState | undefined>(undefined);

export function AnalysisProvider({ children }: { children: ReactNode }) {
  const [hasAnalysis, setHasAnalysis] = useState(false);
  const [currentAnalysisId, setCurrentAnalysisId] = useState<string | null>(null);

  const value = useMemo<AnalysisState>(
    () => ({
      hasAnalysis,
      markAnalyzed: () => setHasAnalysis(true),
      reset: () => setHasAnalysis(false),
      currentAnalysisId,
      setCurrentAnalysisId,
    }),
    [hasAnalysis, currentAnalysisId],
  );

  return <AnalysisContext.Provider value={value}>{children}</AnalysisContext.Provider>;
}

// eslint-disable-next-line react-refresh/only-export-components
export function useAnalysis(): AnalysisState {
  const ctx = useContext(AnalysisContext);
  if (!ctx) throw new Error("useAnalysis must be used within an AnalysisProvider");
  return ctx;
}
