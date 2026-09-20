import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import AuthCallback from "./AuthCallback";
import Login from "./Login";
import Signup from "./Signup";

type AuthShape = { mode: string; loading: boolean; authenticated: boolean };
const auth: AuthShape = { mode: "supabase", loading: true, authenticated: false };

vi.mock("../state/AuthContext", async () => {
  const actual = await vi.importActual<typeof import("../state/AuthContext")>("../state/AuthContext");
  return {
    ...actual,
    useAuth: () => ({
      ...auth,
      user: null,
      session: null,
      signIn: vi.fn(),
      signUp: vi.fn(),
      signOut: vi.fn(),
      requestPasswordReset: vi.fn(),
      signInWithGoogle: vi.fn(),
    }),
  };
});

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/auth/callback" element={<AuthCallback />} />
        <Route path="/login" element={<Login />} />
        <Route path="/signup" element={<Signup />} />
        <Route path="/upload" element={<p>Upload screen</p>} />
        <Route path="/analysis/:id/report" element={<p>Report screen</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("Google OAuth return", () => {
  beforeEach(() => {
    auth.mode = "supabase";
    auth.loading = true;
    auth.authenticated = false;
    window.sessionStorage.clear();
  });

  it("waits while the code is exchanged, then forwards to the remembered destination once", async () => {
    window.sessionStorage.setItem("chelcoach.oauth.returnTo", "/analysis/req-1/report");
    const view = renderAt("/auth/callback?code=abc");
    expect(screen.getByText(/finishing sign-in/i)).toBeInTheDocument();

    auth.loading = false;
    auth.authenticated = true;
    view.rerender(
      <MemoryRouter initialEntries={["/auth/callback?code=abc"]}>
        <Routes>
          <Route path="/auth/callback" element={<AuthCallback />} />
          <Route path="/analysis/:id/report" element={<p>Report screen</p>} />
        </Routes>
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByText("Report screen")).toBeInTheDocument());
    expect(window.sessionStorage.getItem("chelcoach.oauth.returnTo")).toBeNull();
  });

  it("defaults to /upload when no destination was remembered", async () => {
    auth.loading = false;
    auth.authenticated = true;
    renderAt("/auth/callback?code=abc");
    await waitFor(() => expect(screen.getByText("Upload screen")).toBeInTheDocument());
  });

  it("explains a failed exchange instead of silently showing the form again", async () => {
    auth.loading = false;
    auth.authenticated = false;
    renderAt("/auth/callback?error=access_denied&error_description=User%20cancelled");
    expect(await screen.findByRole("alert")).toHaveTextContent("User cancelled");
    expect(screen.getByRole("link", { name: /back to sign in/i })).toBeInTheDocument();
  });

  it("never shows Login or Signup to a player who is already signed in", async () => {
    auth.loading = false;
    auth.authenticated = true;
    renderAt("/login");
    await waitFor(() => expect(screen.getByText("Upload screen")).toBeInTheDocument());
    renderAt("/signup");
    await waitFor(() => expect(screen.getAllByText("Upload screen").length).toBeGreaterThan(0));
    expect(screen.queryByRole("button", { name: /google/i })).not.toBeInTheDocument();
  });
});
