import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";

// Self-hosted fonts & icons — no Google Fonts / Material Symbols network dependency.
// Pro Ice Analytics typography: Oswald (headlines), Inter (body), JetBrains Mono (labels/data).
import "@fontsource/oswald/400.css";
import "@fontsource/oswald/500.css";
import "@fontsource/oswald/600.css";
import "@fontsource/oswald/700.css";
import "@fontsource/inter/400.css";
import "@fontsource/inter/500.css";
import "@fontsource/inter/600.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import "material-symbols/outlined.css";

import "./index.css";
import App from "./App.tsx";
import { PremiumProvider } from "./state/PremiumContext.tsx";
import { AnalysisProvider } from "./state/AnalysisContext.tsx";
import { ReportProvider } from "./state/ReportContext.tsx";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <PremiumProvider>
        <AnalysisProvider>
          <ReportProvider>
            <App />
          </ReportProvider>
        </AnalysisProvider>
      </PremiumProvider>
    </BrowserRouter>
  </StrictMode>,
);
