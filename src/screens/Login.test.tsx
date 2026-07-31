import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import Login from "./Login";
import { AuthActionError } from "../state/AuthContext";

const signIn = vi.fn();

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
    }),
  };
});

describe("Login screen", () => {
  beforeEach(() => {
    signIn.mockReset();
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
