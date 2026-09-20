import { describe, expect, it, beforeEach } from "vitest";
import { OAUTH_CALLBACK_PATH, rememberOAuthReturnTo, takeOAuthReturnTo } from "./oauthReturn";

describe("OAuth return-to handoff", () => {
  beforeEach(() => window.sessionStorage.clear());

  it("uses a fixed same-origin callback path so the Supabase allowlist needs one entry", () => {
    expect(OAUTH_CALLBACK_PATH).toBe("/auth/callback");
  });

  it("round-trips a same-origin path exactly once", () => {
    rememberOAuthReturnTo("/analysis/req-9/report");
    expect(takeOAuthReturnTo()).toBe("/analysis/req-9/report");
    expect(takeOAuthReturnTo()).toBe("/upload");
  });

  it("refuses open redirects", () => {
    rememberOAuthReturnTo("https://evil.example/x");
    expect(takeOAuthReturnTo()).toBe("/");
    rememberOAuthReturnTo("//evil.example");
    expect(takeOAuthReturnTo()).toBe("/");
  });
});
