import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import AskScottie from "./AskScottie";
import { ChatApiError, type ChatMessage } from "../../lib/chatApi";

const getChat = vi.fn();
const sendChat = vi.fn();
vi.mock("../../lib/chatApi", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/chatApi")>();
  return { ...actual, getChat: (...a: unknown[]) => getChat(...a), sendChat: (...a: unknown[]) => sendChat(...a) };
});

const msg = (role: "user" | "assistant", content: string, id = `${role}-${content}`): ChatMessage => ({ id, role, content, createdAt: "2026-09-18T00:00:00Z" });

afterEach(() => vi.clearAllMocks());

describe("AskScottie", () => {
  it("loads the conversation, sends a question, and shows Scottie's grounded reply", async () => {
    getChat.mockResolvedValue([]);
    sendChat.mockResolvedValue({
      reply: msg("assistant", "Start with the late slot arrival around 20s."),
      messages: [msg("user", "What should I fix first?"), msg("assistant", "Start with the late slot arrival around 20s.")],
    });
    render(<AskScottie applicationRequestId="req-1" />);
    expect(await screen.findByText(/No questions yet/)).toBeInTheDocument();
    expect(screen.getByText(/Answers come only from this report's sampled frames/)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(/Ask Scottie about this clip/), { target: { value: "What should I fix first?" } });
    fireEvent.click(screen.getByRole("button", { name: /^ask$/i }));

    expect(await screen.findByTestId("chat-assistant")).toHaveTextContent("late slot arrival around 20s");
    expect(sendChat).toHaveBeenCalledWith("req-1", "What should I fix first?");
    expect(screen.getByTestId("chat-user")).toHaveTextContent("What should I fix first?");
    expect((screen.getByLabelText(/Ask Scottie about this clip/) as HTMLTextAreaElement).value).toBe("");
  });

  it("a suggestion chip sends that question", async () => {
    getChat.mockResolvedValue([]);
    sendChat.mockResolvedValue({ reply: msg("assistant", "One drill: ..."), messages: [msg("user", "Give me one drill for this week."), msg("assistant", "One drill: ...")] });
    render(<AskScottie applicationRequestId="req-1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Give me one drill for this week." }));
    await waitFor(() => expect(sendChat).toHaveBeenCalledWith("req-1", "Give me one drill for this week."));
  });

  it("on a daily-limit or outage error it keeps the draft and shows the message", async () => {
    getChat.mockResolvedValue([msg("user", "earlier"), msg("assistant", "earlier reply")]);
    sendChat.mockRejectedValue(new ChatApiError("RATE_LIMITED", "You have reached today's limit for questions to Scottie. Try again tomorrow.", 429, true));
    render(<AskScottie applicationRequestId="req-1" />);
    expect(await screen.findByText("earlier reply")).toBeInTheDocument();
    const input = screen.getByLabelText(/Ask Scottie about this clip/) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "another one" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(await screen.findByRole("alert")).toHaveTextContent(/today's limit/);
    expect(input.value).toBe("another one", "the question is not lost");
    expect(screen.getAllByTestId("chat-user")).toHaveLength(1, "the optimistic bubble was rolled back");
  });
});
