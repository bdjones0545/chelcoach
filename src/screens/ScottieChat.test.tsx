import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import ScottieChat from "./ScottieChat";
import { ChatApiError, type CoachChatState } from "../lib/chatApi";

const getCoachChat = vi.fn<(signal?: AbortSignal) => Promise<CoachChatState>>();
const sendCoachChat = vi.fn();

vi.mock("../lib/chatApi", async () => {
  const actual = await vi.importActual<typeof import("../lib/chatApi")>("../lib/chatApi");
  return { ...actual, getCoachChat: (s?: AbortSignal) => getCoachChat(s), sendCoachChat: (m: string) => sendCoachChat(m) };
});
vi.mock("../components/TopAppBar", () => ({ default: () => <header>bar</header> }));
vi.mock("../state/AnalysisContext", () => ({ useAnalysis: () => ({ currentAnalysisId: null }) }));

function mount() {
  return render(
    <MemoryRouter initialEntries={["/scottie"]}>
      <ScottieChat />
    </MemoryRouter>,
  );
}

describe("Scottie tab", () => {
  beforeEach(() => {
    getCoachChat.mockReset();
    sendCoachChat.mockReset();
  });

  it("is usable with no report: says Scottie hasn't seen the film and links to upload", async () => {
    getCoachChat.mockResolvedValue({ messages: [], grounding: null });
    mount();
    expect(await screen.findByTestId("coach-ungrounded")).toHaveTextContent(/hasn’t seen your film yet/);
    expect(screen.getByRole("link", { name: /upload a clip/i })).toHaveAttribute("href", "/upload");
    expect(screen.getByRole("button", { name: /walked on the rush/i })).toBeInTheDocument();
  });

  it("says which report Scottie is grounded in and links to it", async () => {
    getCoachChat.mockResolvedValue({
      messages: [],
      grounding: { applicationRequestId: "req-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", gameTitle: "NHL 27", gameMode: "eashl", completedAt: "2026-09-19T20:00:00Z" },
    });
    mount();
    expect(await screen.findByTestId("coach-grounding")).toHaveTextContent(/latest report \(NHL 27/);
    expect(screen.getByRole("link", { name: /open it/i })).toHaveAttribute("href", "/analysis/req-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/report");
  });

  it("sends a question, shows Scottie's reply, and keeps the draft on failure", async () => {
    getCoachChat.mockResolvedValue({ messages: [], grounding: null });
    sendCoachChat.mockResolvedValueOnce({
      reply: { id: "a1", role: "assistant", content: "I have not seen your film yet — in general, close the gap earlier.", createdAt: "2026-09-20T00:00:00Z" },
      messages: [
        { id: "u1", role: "user", content: "How do I stop getting walked?", createdAt: "2026-09-20T00:00:00Z" },
        { id: "a1", role: "assistant", content: "I have not seen your film yet — in general, close the gap earlier.", createdAt: "2026-09-20T00:00:00Z" },
      ],
      grounding: null,
    });
    mount();
    await screen.findByTestId("coach-ungrounded");
    fireEvent.change(screen.getByLabelText(/ask scottie a coaching question/i), { target: { value: "How do I stop getting walked?" } });
    fireEvent.click(screen.getByRole("button", { name: /^ask$/i }));
    await waitFor(() => expect(screen.getByTestId("chat-assistant")).toHaveTextContent(/close the gap earlier/));
    expect(sendCoachChat).toHaveBeenCalledWith("How do I stop getting walked?");

    sendCoachChat.mockRejectedValueOnce(new ChatApiError("PROVIDER_UNAVAILABLE", "Scottie is unavailable right now. Your question was not counted.", 503, true));
    fireEvent.change(screen.getByLabelText(/ask scottie a coaching question/i), { target: { value: "Second question" } });
    fireEvent.click(screen.getByRole("button", { name: /^ask$/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/not counted/);
    expect(screen.getByLabelText(/ask scottie a coaching question/i)).toHaveValue("Second question");
  });
});
