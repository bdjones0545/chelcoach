import { createContext, useCallback, useContext, useMemo, useState } from "react";
import type { ReactNode } from "react";

interface AnalysisState {
  /** Whether the user has a completed game analysis in this session (mock, in-memory). */
  hasAnalysis: boolean;
  /**
   * Clip currently being processed in live (backend) mode.
   * Null in intentional demo mode — Processing must not poll.
   */
  activeClipId: string | null;
  markAnalyzed: () => void;
  setActiveClipId: (clipId: string | null) => void;
  /** Clear the active live job but keep hasAnalysis as-is. */
  clearActiveClip: () => void;
  reset: () => void;
}

const AnalysisContext = createContext<AnalysisState | undefined>(undefined);

export function AnalysisProvider({ children }: { children: ReactNode }) {
  const [hasAnalysis, setHasAnalysis] = useState(false);
  const [activeClipId, setActiveClipIdState] = useState<string | null>(null);

  const setActiveClipId = useCallback((clipId: string | null) => {
    setActiveClipIdState(clipId);
  }, []);

  const clearActiveClip = useCallback(() => {
    setActiveClipIdState(null);
  }, []);

  const value = useMemo<AnalysisState>(
    () => ({
      hasAnalysis,
      activeClipId,
      markAnalyzed: () => setHasAnalysis(true),
      setActiveClipId,
      clearActiveClip,
      reset: () => {
        setHasAnalysis(false);
        setActiveClipIdState(null);
      },
    }),
    [hasAnalysis, activeClipId, setActiveClipId, clearActiveClip],
  );

  return <AnalysisContext.Provider value={value}>{children}</AnalysisContext.Provider>;
}

// eslint-disable-next-line react-refresh/only-export-components
export function useAnalysis(): AnalysisState {
  const ctx = useContext(AnalysisContext);
  if (!ctx) throw new Error("useAnalysis must be used within an AnalysisProvider");
  return ctx;
}
