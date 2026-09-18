import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import Upload from "./Upload";

const createUploadSession = vi.fn();
const fetchAnalysisReadiness = vi.fn();

vi.mock("../lib/scottyUploadApi", () => ({
  cancelUpload: vi.fn(),
  createUploadSession: (...args: unknown[]) => createUploadSession(...args),
  ensureOwnerSession: vi.fn(async () => "owner-token"),
  fetchGameplayProfile: vi.fn(async () => null),
  getUpload: vi.fn(),
  uploadDirect: vi.fn(),
}));

vi.mock("../lib/readinessApi", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/readinessApi")>();
  return { ...actual, fetchAnalysisReadiness: (...args: unknown[]) => fetchAnalysisReadiness(...args) };
});

vi.mock("../lib/playerIdentificationApi", () => ({ storeReadyUploadId: vi.fn() }));

function renderUpload() {
  return render(
    <MemoryRouter initialEntries={["/upload"]}>
      <Routes>
        <Route path="/upload" element={<Upload />} />
        <Route path="/processing" element={<div>MOCK PROCESSING ROUTE</div>} />
        <Route path="/player-confirmation" element={<div>player confirmation</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

function fillForm() {
  const file = new File([new Uint8Array(1024)], "shift.mp4", { type: "video/mp4" });
  fireEvent.change(screen.getByLabelText("Choose a game clip to upload"), { target: { files: [file] } });
  fireEvent.change(screen.getByLabelText("NHL title"), { target: { value: "nhl-25" } });
  fireEvent.change(screen.getByLabelText("Platform"), { target: { value: "xbox_series" } });
  fireEvent.change(screen.getByLabelText("Control scheme"), { target: { value: "skill_stick" } });
  fireEvent.change(screen.getByLabelText("Position"), { target: { value: "C" } });
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("Upload — production flow, no mock fallback", () => {
  it("never routes a real upload into the demo processing loop", async () => {
    fetchAnalysisReadiness.mockResolvedValue("enabled");
    createUploadSession.mockRejectedValue(new Error("stop here"));
    renderUpload();
    await waitFor(() => expect(fetchAnalysisReadiness).toHaveBeenCalled());
    fillForm();

    const submit = await screen.findByRole("button", { name: /get my chel rating/i });
    await waitFor(() => expect(submit).toBeEnabled());
    fireEvent.click(submit);

    await waitFor(() => expect(createUploadSession).toHaveBeenCalledTimes(1));
    expect(screen.queryByText("MOCK PROCESSING ROUTE")).not.toBeInTheDocument();
  });

  it("shows the closed notice and disables submit while the server reports analysis disabled", async () => {
    fetchAnalysisReadiness.mockResolvedValue("disabled");
    renderUpload();
    expect(await screen.findByTestId("analysis-closed-notice")).toBeInTheDocument();
    fillForm();

    const submit = screen.getByRole("button", { name: /analysis opens soon/i });
    expect(submit).toBeDisabled();
    fireEvent.click(submit);
    expect(createUploadSession).not.toHaveBeenCalled();
    expect(screen.queryByText("MOCK PROCESSING ROUTE")).not.toBeInTheDocument();
  });
});

describe("Upload — position is only mandatory in single-skater modes", () => {
  it("HUT (team control) defaults position to 'switches', accepts it, and keeps the submit enabled", async () => {
    fetchAnalysisReadiness.mockResolvedValue("enabled");
    createUploadSession.mockRejectedValue(new Error("stop here"));
    renderUpload();
    await waitFor(() => expect(fetchAnalysisReadiness).toHaveBeenCalled());
    fillForm();
    fireEvent.change(screen.getByLabelText("Game mode"), { target: { value: "hut" } });

    const position = screen.getByLabelText("Position") as HTMLSelectElement;
    expect(position.value).toBe("unknown");
    expect(screen.getByRole("option", { name: /switches/i })).toBeInTheDocument();
    expect(screen.getByText(/controlling the skater with the indicator/i)).toBeInTheDocument();

    const submit = screen.getByRole("button", { name: /get my chel rating/i });
    await waitFor(() => expect(submit).toBeEnabled());
    fireEvent.click(submit);
    await waitFor(() => expect(createUploadSession).toHaveBeenCalledTimes(1));
    const ctx = (createUploadSession.mock.calls[0]![1] as { context: { playerContext: { position: string; gameMode: string } } }).context;
    expect(ctx.playerContext).toMatchObject({ position: "unknown", gameMode: "hut" });
  });

  it("EASHL requires a real position and offers no 'switches' option", async () => {
    fetchAnalysisReadiness.mockResolvedValue("enabled");
    renderUpload();
    await waitFor(() => expect(fetchAnalysisReadiness).toHaveBeenCalled());
    fillForm();
    fireEvent.change(screen.getByLabelText("Game mode"), { target: { value: "hut" } });
    fireEvent.change(screen.getByLabelText("Game mode"), { target: { value: "eashl" } });
    expect(screen.queryByRole("option", { name: /switches/i })).not.toBeInTheDocument();
    expect((screen.getByLabelText("Position") as HTMLSelectElement).value).not.toBe("unknown");
    expect(screen.getByText(/I control one skater/i)).toBeInTheDocument();
  });
});
