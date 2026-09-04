import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AUTH_UNAVAILABLE_USER_MESSAGE,
  authUnavailableUserMessage,
  getSupabaseBrowserClient,
  getSupabaseBrowserConfigStatus,
  isSupabaseBrowserConfigured,
  readSupabaseBrowserConfig,
  resetSupabaseBrowserClientForTests,
} from "./supabaseClient";
import { isApiOriginAllowed } from "./authenticatedFetch";

describe("supabase browser client config", () => {
  afterEach(() => {
    resetSupabaseBrowserClientForTests();
    vi.unstubAllEnvs();
  });

  it("detects missing Vite Supabase URL", () => {
    vi.stubEnv("VITE_SUPABASE_URL", "");
    vi.stubEnv("VITE_SUPABASE_ANON_KEY", "test-anon-key");
    expect(getSupabaseBrowserConfigStatus()).toEqual({
      configured: false,
      reason: "missing_url",
    });
    expect(isSupabaseBrowserConfigured()).toBe(false);
    expect(getSupabaseBrowserClient()).toBeNull();
  });

  it("detects missing Vite anon key", () => {
    vi.stubEnv("VITE_SUPABASE_URL", "https://example.supabase.co");
    vi.stubEnv("VITE_SUPABASE_ANON_KEY", "");
    expect(getSupabaseBrowserConfigStatus()).toEqual({
      configured: false,
      reason: "missing_anon_key",
    });
    expect(readSupabaseBrowserConfig()).toBeNull();
    expect(getSupabaseBrowserClient()).toBeNull();
  });

  it("detects invalid Supabase URL", () => {
    vi.stubEnv("VITE_SUPABASE_URL", "http://evil.example");
    vi.stubEnv("VITE_SUPABASE_ANON_KEY", "test-anon-key");
    expect(getSupabaseBrowserConfigStatus()).toEqual({
      configured: false,
      reason: "invalid_url",
    });
    expect(readSupabaseBrowserConfig()).toBeNull();
    expect(getSupabaseBrowserClient()).toBeNull();
  });

  it("does not create a client with empty values", () => {
    vi.stubEnv("VITE_SUPABASE_URL", "");
    vi.stubEnv("VITE_SUPABASE_ANON_KEY", "");
    expect(getSupabaseBrowserClient()).toBeNull();
  });

  it("validates https URL + anon key", () => {
    vi.stubEnv("VITE_SUPABASE_URL", "https://example.supabase.co");
    vi.stubEnv("VITE_SUPABASE_ANON_KEY", "test-anon-key");
    expect(isSupabaseBrowserConfigured()).toBe(true);
    const cfg = readSupabaseBrowserConfig();
    expect(cfg?.url).toContain("supabase.co");
    expect(cfg?.anonKey).toBe("test-anon-key");
  });

  it("uses a generic production unavailable message", () => {
    expect(
      authUnavailableUserMessage({ configured: false, reason: "missing_url" }, true),
    ).toBe(AUTH_UNAVAILABLE_USER_MESSAGE);
    expect(AUTH_UNAVAILABLE_USER_MESSAGE).not.toMatch(/VITE_/);
    expect(AUTH_UNAVAILABLE_USER_MESSAGE).not.toMatch(/SUPABASE_/);
  });

  it("development diagnostics may name the missing Vite key", () => {
    expect(
      authUnavailableUserMessage({ configured: false, reason: "missing_anon_key" }, false),
    ).toMatch(/VITE_SUPABASE_ANON_KEY/);
  });
});

describe("authenticatedFetch origin allowlist", () => {
  it("allows ChelCoach API origin only", () => {
    expect(isApiOriginAllowed("http://localhost:3001/api/gameplay-profile")).toBe(true);
    expect(isApiOriginAllowed("https://evil.example/api/steal")).toBe(false);
    expect(isApiOriginAllowed("https://example.supabase.co/storage/v1/object")).toBe(false);
  });
});
