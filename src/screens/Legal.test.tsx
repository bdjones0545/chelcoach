import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import App from "../App";
import { AnalysisProvider } from "../state/AnalysisContext";
import { PremiumProvider } from "../state/PremiumContext";
import { ReportProvider } from "../state/ReportContext";
import Privacy from "./Privacy";
import Terms from "./Terms";
import Upload from "./Upload";

// Upload talks to the API on mount; keep those calls out of a copy test so nothing resolves
// after the environment is torn down.
vi.mock("../lib/scottyUploadApi", () => ({
  cancelUpload: vi.fn(),
  createUploadSession: vi.fn(),
  ensureOwnerSession: vi.fn(async () => "owner-token"),
  fetchGameplayProfile: vi.fn(async () => null),
  getUpload: vi.fn(),
  uploadDirect: vi.fn(),
}));
vi.mock("../lib/readinessApi", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/readinessApi")>();
  return { ...actual, fetchAnalysisReadiness: vi.fn(async () => "enabled" as const) };
});
vi.mock("../lib/playerIdentificationApi", () => ({ storeReadyUploadId: vi.fn() }));

function at(path: string, node: React.ReactNode) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AnalysisProvider>
        <PremiumProvider>
          <ReportProvider>{node}</ReportProvider>
        </PremiumProvider>
      </AnalysisProvider>
    </MemoryRouter>,
  );
}

describe("legal pages", () => {
  it("/privacy states retention, the frame-only model input, and every processor", () => {
    at("/privacy", <Privacy />);
    expect(screen.getByRole("heading", { name: /privacy policy/i })).toBeInTheDocument();
    expect(screen.getByText(/deleted automatically 24 hours after upload/i)).toBeInTheDocument();
    expect(screen.getByText(/full video is never sent to the model provider/i)).toBeInTheDocument();
    for (const p of ["Supabase", "Vercel", "xAI", "Cloudflare"]) {
      expect(screen.getByText(new RegExp(`^${p} \\(`))).toBeInTheDocument();
    }
    expect(screen.queryByText(/free trial|cancel anytime/i)).not.toBeInTheDocument();
  });

  it("/terms says the rating is an estimate and the service is free with no billing", () => {
    at("/terms", <Terms />);
    expect(screen.getByRole("heading", { name: /terms of service/i })).toBeInTheDocument();
    expect(screen.getByText(/rubric estimate/i)).toBeInTheDocument();
    expect(screen.getByText(/no subscription, trial or billing/i)).toBeInTheDocument();
  });

  it("the app routes /privacy and /terms publicly (no auth guard)", () => {
    at("/privacy", <App />);
    expect(screen.getByRole("heading", { name: /privacy policy/i })).toBeInTheDocument();
  });

  it("the upload screen no longer claims not to collect an email, and links the policy", async () => {
    at(
      "/upload",
      <Routes>
        <Route path="/upload" element={<Upload />} />
      </Routes>,
    );
    expect(screen.queryByText(/or email/i)).not.toBeInTheDocument();
    expect(await screen.findByRole("link", { name: /privacy policy/i })).toHaveAttribute("href", "/privacy");
  });
});
