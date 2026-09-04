import { describe, expect, it } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import Landing from "./Landing";
import { AnalysisProvider } from "../state/AnalysisContext";

describe("Landing Sign In", () => {
  it("navigates to /login when Sign In is pressed", () => {
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
});
