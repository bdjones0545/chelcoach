/**
 * LEGACY / DEMO-ONLY upload routes (Phase 2).
 *
 *   POST /api/uploads/init      validate metadata, create a clip, return an upload target
 *   PUT  /api/clips/:id/file    receive the raw bytes and store them (BUFFERED)
 *
 * ⚠️  This path buffers the full request body in Node memory via express.raw().
 * It must NOT be used for production full-game uploads (up to 2 GB / 30 minutes).
 *
 * Production traffic must use Scotty Step 2 streamed sessions:
 *   POST /api/uploads → PUT /api/uploads/:id/content
 *
 * Removal plan: delete once demo smoke + VITE legacy flag are retired (post Step 4+).
 * Hard cap below keeps accidental large uploads from exhausting RAM.
 */
import { Router, raw } from "express";
import type { UploadInitResponse } from "../contract";
import { uploadInitRequestSchema, uploadRules, validateUploadMetadata } from "../contract";
import { ClipStoreError, createClip, getClip, markUploaded } from "../store";
import { getStorage } from "../storage";

export const uploadsRouter = Router();

/**
 * Demo/legacy buffered upload cap — far below full-game CHELCOACH_MAX_UPLOAD_BYTES.
 * Override with CHELCOACH_LEGACY_UPLOAD_MAX_BYTES for local demos only.
 */
export function getLegacyUploadMaxBytes(): number {
  const raw = process.env.CHELCOACH_LEGACY_UPLOAD_MAX_BYTES;
  if (raw !== undefined && raw !== "") {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return Math.floor(n);
  }
  return 50 * 1024 * 1024; // 50 MiB
}

/** POST /api/uploads/init — legacy demo init (not the Scotty upload session). */
uploadsRouter.post("/uploads/init", (req, res) => {
  const parsed = uploadInitRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_request", message: "Body must be { filename, contentType, sizeBytes }." });
    return;
  }

  const legacyMax = getLegacyUploadMaxBytes();
  if (parsed.data.sizeBytes > legacyMax) {
    res.status(413).json({
      error: "oversized_file",
      message:
        "Legacy demo upload path rejects large files. Use POST /api/uploads (streamed session) for full-game uploads.",
      legacy: true,
      maxBytes: legacyMax,
    });
    return;
  }

  const invalid = validateUploadMetadata(parsed.data);
  if (invalid) {
    res.status(invalid.code === "oversized_file" ? 413 : 415).json({ error: invalid.code, message: invalid.message });
    return;
  }

  const clip = createClip(parsed.data);
  const body: UploadInitResponse = { clipId: clip.id, uploadUrl: `/api/clips/${clip.id}/file` };
  res.status(201).json({
    ...body,
    legacy: true,
    warning: "Demo-only buffered upload. Production clients must use /api/uploads streamed sessions.",
  });
});

/** PUT /api/clips/:id/file — BUFFERED legacy store (capped). */
uploadsRouter.put(
  "/clips/:id/file",
  raw({ type: () => true, limit: getLegacyUploadMaxBytes() }),
  async (req, res) => {
    try {
      const legacyMax = getLegacyUploadMaxBytes();
      const clip = getClip(req.params.id);
      if (!clip) {
        res.status(404).json({ error: "not_found", message: "No such clip." });
        return;
      }
      if (clip.status !== "uploading") {
        res.status(409).json({ error: "invalid_state", message: `Clip is "${clip.status}", not awaiting upload.` });
        return;
      }

      const body = req.body as Buffer;
      if (!Buffer.isBuffer(body) || body.length === 0) {
        res.status(400).json({ error: "empty_upload", message: "Request body was empty." });
        return;
      }
      if (body.length > legacyMax) {
        res.status(413).json({
          error: "oversized_file",
          message: "Legacy demo upload path rejects large files. Use streamed /api/uploads/:id/content.",
          legacy: true,
        });
        return;
      }
      // Ignore unused uploadRules.maxBytes for this path — legacy hard-cap wins.
      void uploadRules;

      await getStorage().put(clip.storageKey, body, clip.contentType);
      const updated = markUploaded(clip.id, body.length);
      res.status(200).json({
        clipId: updated.id,
        status: updated.status,
        storedBytes: updated.storedBytes,
        legacy: true,
      });
    } catch (err) {
      if (err instanceof ClipStoreError) {
        res.status(err.httpStatus).json({ error: err.code, message: err.message });
        return;
      }
      throw err;
    }
  },
);
