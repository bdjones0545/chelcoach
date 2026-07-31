import { afterEach, describe, expect, it, vi } from "vitest";
import {
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

  it("missing Vite config produces disabled state", () => {
    vi.stubEnv("VITE_SUPABASE_URL", "");
    vi.stubEnv("VITE_SUPABASE_ANON_KEY", "");
    expect(isSupabaseBrowserConfigured()).toBe(false);
    expect(readSupabaseBrowserConfig()).toBeNull();
  });

  it("validates https URL + anon key", () => {
    vi.stubEnv("VITE_SUPABASE_URL", "https://example.supabase.co");
    vi.stubEnv("VITE_SUPABASE_ANON_KEY", "test-anon-key");
    expect(isSupabaseBrowserConfigured()).toBe(true);
    const cfg = readSupabaseBrowserConfig();
    expect(cfg?.url).toContain("supabase.co");
    expect(cfg?.anonKey).toBe("test-anon-key");
  });

  it("rejects non-https remote URLs", () => {
    vi.stubEnv("VITE_SUPABASE_URL", "http://evil.example");
    vi.stubEnv("VITE_SUPABASE_ANON_KEY", "test-anon-key");
    expect(readSupabaseBrowserConfig()).toBeNull();
  });
});

describe("authenticatedFetch origin allowlist", () => {
  it("allows ChelCoach API origin only", () => {
    expect(isApiOriginAllowed("http://localhost:3001/api/gameplay-profile")).toBe(true);
    expect(isApiOriginAllowed("https://evil.example/api/steal")).toBe(false);
    expect(isApiOriginAllowed("https://example.supabase.co/storage/v1/object")).toBe(false);
  });
});
