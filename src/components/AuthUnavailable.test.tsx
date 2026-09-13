import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import AuthUnavailable from "./AuthUnavailable";

describe("AuthUnavailable", () => {
  it("renders a disabled sign-in control, an alert, and a dev continue path outside production", () => {
    const onDevContinue = vi.fn();
    render(
      <MemoryRouter>
        <AuthUnavailable title="Sign in" onDevContinue={onDevContinue} />
      </MemoryRouter>,
    );
    expect(screen.getByTestId("auth-unavailable")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /sign in unavailable/i })).toBeDisabled();
    expect(screen.getByRole("alert")).toBeInTheDocument();
    // Vitest runs with PROD=false, so the development continue path is offered.
    fireEvent.click(screen.getByRole("button", { name: /continue without browser sign-in/i }));
    expect(onDevContinue).toHaveBeenCalledTimes(1);
  });

  it("offers no continue path when none is provided", () => {
    render(
      <MemoryRouter>
        <AuthUnavailable title="Reset password" />
      </MemoryRouter>,
    );
    expect(screen.queryByRole("button", { name: /continue without/i })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: /back to home/i })).toBeInTheDocument();
  });
});
