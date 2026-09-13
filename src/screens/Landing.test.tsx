import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import Landing from "./Landing";
import { AnalysisProvider } from "../state/AnalysisContext";

describe("Landing", () => {
  it("Sign In navigates to /login (it used to be an inert button)", () => {
    render(
      <MemoryRouter initialEntries={["/"]}>
        <AnalysisProvider>
          <Routes>
            <Route path="/" element={<Landing />} />
            <Route path="/login" element={<div>Login route</div>} />
          </Routes>
        </AnalysisProvider>
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole("button", { name: /sign in/i }));
    expect(screen.getByText("Login route")).toBeInTheDocument();
  });

  it("does not promise a flow without sign-up when /upload requires an account", () => {
    render(
      <MemoryRouter initialEntries={["/"]}>
        <AnalysisProvider>
          <Landing />
        </AnalysisProvider>
      </MemoryRouter>,
    );
    expect(screen.queryByText(/no sign-up/i)).not.toBeInTheDocument();
  });
});
