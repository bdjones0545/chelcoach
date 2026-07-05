import { createContext, useContext, useMemo, useState } from "react";
import type { ReactNode } from "react";

interface AnalysisState {
  /** Whether the user has a completed game analysis in this session (mock, in-memory). */
  hasAnalysis: boolean;
  markAnalyzed: () => void;
  reset: () => void;
}

const AnalysisContext = createContext<AnalysisState | undefined>(undefined);

export function AnalysisProvider({ children }: { children: ReactNode }) {
  const [hasAnalysis, setHasAnalysis] = useState(false);

  const value = useMemo<AnalysisState>(
    () => ({
      hasAnalysis,
      markAnalyzed: () => setHasAnalysis(true),
      reset: () => setHasAnalysis(false),
    }),
    [hasAnalysis],
  );

  return <AnalysisContext.Provider value={value}>{children}</AnalysisContext.Provider>;
}

// eslint-disable-next-line react-refresh/only-export-components
export function useAnalysis(): AnalysisState {
  const ctx = useContext(AnalysisContext);
  if (!ctx) throw new Error("useAnalysis must be used within an AnalysisProvider");
  return ctx;
}
