import { createContext, useContext, useMemo, useState } from "react";
import type { ReactNode } from "react";

interface PremiumState {
  /** Whether the user has "unlocked" the full film breakdown (mock, no payment). */
  isPremium: boolean;
  unlock: () => void;
  reset: () => void;
}

const PremiumContext = createContext<PremiumState | undefined>(undefined);

export function PremiumProvider({ children }: { children: ReactNode }) {
  const [isPremium, setIsPremium] = useState(false);

  const value = useMemo<PremiumState>(
    () => ({
      isPremium,
      unlock: () => setIsPremium(true),
      reset: () => setIsPremium(false),
    }),
    [isPremium],
  );

  return <PremiumContext.Provider value={value}>{children}</PremiumContext.Provider>;
}

// eslint-disable-next-line react-refresh/only-export-components
export function usePremium(): PremiumState {
  const ctx = useContext(PremiumContext);
  if (!ctx) throw new Error("usePremium must be used within a PremiumProvider");
  return ctx;
}
