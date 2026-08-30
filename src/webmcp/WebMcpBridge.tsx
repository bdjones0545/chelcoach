import { useMemo } from "react";

import { useAnalysis } from "../state/AnalysisContext";
import { usePremium } from "../state/PremiumContext";
import { useReport } from "../state/ReportContext";
import { buildChelCoachTools } from "./tools";
import { useWebMcpTools } from "./useWebMcp";

/**
 * Publishes ChelCoach's read-only tools to any AI agent driving the page.
 * Renders nothing, and is a no-op unless VITE_WEBMCP_ENABLED is set.
 * See src/webmcp/README.md.
 */
export default function WebMcpBridge() {
  const { report, source } = useReport();
  const { isPremium } = usePremium();
  const { hasAnalysis } = useAnalysis();

  useWebMcpTools(
    buildChelCoachTools,
    useMemo(
      () => ({ report, source, isPremium, hasAnalysis }),
      [report, source, isPremium, hasAnalysis],
    ),
  );

  return null;
}
