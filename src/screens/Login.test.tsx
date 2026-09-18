import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import Login from "./Login";
import { AuthActionError } from "../state/AuthContext";

const signIn = vi.fn();
const signInWithGoogle = vi.fn();

vi.mock("../state/AuthContext", async () => {
  const actual = await vi.importActual<typeof import("../state/AuthContext")>("../state/AuthContext");
  return {
    ...actual,
    useAuth: () => ({
      mode: "supabase",
      user: null,
      session: null,
      loading: false,
      authenticated: false,
      signIn,
      signUp: vi.fn(),
      signOut: vi.fn(),
      requestPasswordReset: vi.fn(),
      signInWithGoogle,
    }),
  };
});

describe("Login screen", () => {
  beforeEach(() => {
    signIn.mockReset();
    signInWithGoogle.mockReset();
  });

  it("offers Google sign-in that returns to where the player was headed", async () => {
    signInWithGoogle.mockResolvedValue(undefined);
    render(
      <MemoryRouter initialEntries={[{ pathname: "/login", state: { from: "/analysis/req-1/report" } }]}>
        <Login />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole("button", { name: /continue with google/i }));
    await waitFor(() => expect(signInWithGoogle).toHaveBeenCalledWith("/analysis/req-1/report"));
  });

  it("shows a message and stays usable when Google sign-in cannot start", async () => {
    signInWithGoogle.mockRejectedValue(new AuthActionError("AUTH_PROVIDER_UNAVAILABLE", "Google sign-in is not available right now. Use your email and password."));
    render(
      <MemoryRouter>
        <Login />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole("button", { name: /continue with google/i }));
    expect(await screen.findByText(/Google sign-in is not available right now/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /continue with google/i })).toBeEnabled();
  });

  it("submits email/password and calls signIn", async () => {
    signIn.mockResolvedValue(undefined);
    render(
      <MemoryRouter>
        <Login />
      </MemoryRouter>,
    );
    fireEvent.change(screen.getByLabelText(/email/i), { target: { value: "a@example.com" } });
    fireEvent.change(screen.getByLabelText(/password/i), { target: { value: "secret12" } });
    fireEvent.click(screen.getByRole("button", { name: /sign in/i }));
    await waitFor(() => expect(signIn).toHaveBeenCalledWith("a@example.com", "secret12"));
  });

  it("shows invalid credentials error", async () => {
    signIn.mockRejectedValue(new AuthActionError("INVALID_CREDENTIALS", "Invalid email or password."));
    render(
      <MemoryRouter>
        <Login />
      </MemoryRouter>,
    );
    fireEvent.change(screen.getByLabelText(/email/i), { target: { value: "a@example.com" } });
    fireEvent.change(screen.getByLabelText(/password/i), { target: { value: "bad" } });
    fireEvent.click(screen.getByRole("button", { name: /sign in/i }));
    expect(await screen.findByText(/invalid email or password/i)).toBeInTheDocument();
  });
});
