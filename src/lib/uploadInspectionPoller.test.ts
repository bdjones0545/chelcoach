import { describe, expect, it, vi } from "vitest";
import { inspectionStageLabel } from "./uploadInspectionPoller";
import type { PublicUploadDetail } from "./scottyUploadApi";

function detail(partial: Partial<PublicUploadDetail>): PublicUploadDetail {
  return {
    uploadId: "u1",
    uploadStatus: "processing",
    displayFilename: "a.mp4",
    byteSize: 10,
    retentionNotice: "notice",
    ...partial,
  };
}

describe("uploadInspectionPoller labels", () => {
  it("uses stage labels without inventing percentages", () => {
    expect(inspectionStageLabel(detail({ uploadStatus: "uploaded" }))).toBe("Upload complete");
    expect(
      inspectionStageLabel(
        detail({ inspection: { status: "queued", message: "wait", retryable: true } }),
      ),
    ).toBe("Waiting for verification");
    expect(
      inspectionStageLabel(
        detail({ inspection: { status: "inspecting", message: "x", retryable: true } }),
      ),
    ).toBe("Inspecting gameplay video");
    expect(
      inspectionStageLabel(
        detail({ inspection: { status: "validating", message: "x", retryable: true } }),
      ),
    ).toBe("Validating media");
    expect(inspectionStageLabel(detail({ uploadStatus: "ready" }))).toBe(
      "Ready for player identification",
    );
  });

  it("module surface has no service-role secrets", async () => {
    const mod = await import("./uploadInspectionPoller");
    expect(JSON.stringify(mod)).not.toMatch(/SERVICE_ROLE|service_role|DATABASE_URL/i);
    vi.clearAllMocks();
  });
});
