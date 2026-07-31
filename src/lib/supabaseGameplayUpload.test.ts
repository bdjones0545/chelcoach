import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

vi.mock("./supabaseClient", () => ({
  readSupabaseBrowserConfig: () => ({
    url: "https://example.supabase.co",
    anonKey: "public-anon-key",
  }),
  getSupabaseBrowserClient: () => ({
    auth: {
      getSession: async () => ({
        data: { session: { access_token: "user-access-token" } },
        error: null,
      }),
    },
  }),
}));

describe("supabaseGameplayUpload endpoint guard", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("rejects non-approved storage hosts", async () => {
    const { uploadGameplayViaSupabaseTus, SupabaseGameplayUploadError } = await import(
      "./supabaseGameplayUpload"
    );
    const file = new File([new Uint8Array([1, 2, 3])], "clip.mp4", { type: "video/mp4" });
    await expect(
      uploadGameplayViaSupabaseTus({
        session: {
          uploadId: "u1",
          bucket: "chelcoach-gameplay",
          objectPath: "owner/u1/source",
          resumableEndpoint: "https://evil.example/storage/v1/upload/resumable",
          maxBytes: 10_000,
        },
        file,
      }),
    ).rejects.toBeInstanceOf(SupabaseGameplayUploadError);
  });

  it("does not expose service-role concepts in module exports surface", async () => {
    const mod = await import("./supabaseGameplayUpload");
    expect(JSON.stringify(mod)).not.toMatch(/SERVICE_ROLE|service_role|DATABASE_URL/i);
  });
});
