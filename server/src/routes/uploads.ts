/**
 * Upload routes (Phase 2) — real file upload into object storage.
 *
 *   POST /api/uploads/init      validate metadata, create a clip, return an upload target
 *   PUT  /api/clips/:id/file    receive the raw bytes and store them
 *
 * Server-proxied upload (client → API → object storage). No ffmpeg/AI: once bytes are
 * stored the clip is "queued"; `commit` (in clips.ts) finalizes it with the static report.
 */
import { Router, raw } from "express";
import type { UploadInitResponse } from "../contract";
import { uploadInitRequestSchema, uploadRules, validateUploadMetadata } from "../contract";
import { ClipStoreError, createClip, getClip, markUploaded } from "../store";
import { getStorage } from "../storage";

export const uploadsRouter = Router();

/** POST /api/uploads/init — validate + create a clip, return where to upload the bytes. */
uploadsRouter.post("/uploads/init", (req, res) => {
  const parsed = uploadInitRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_request", message: "Body must be { filename, contentType, sizeBytes }." });
    return;
  }

  const invalid = validateUploadMetadata(parsed.data);
  if (invalid) {
    res.status(invalid.code === "oversized_file" ? 413 : 415).json({ error: invalid.code, message: invalid.message });
    return;
  }

  const clip = createClip(parsed.data);
  const body: UploadInitResponse = { clipId: clip.id, uploadUrl: `/api/clips/${clip.id}/file` };
  res.status(201).json(body);
});

/** PUT /api/clips/:id/file — store the uploaded bytes (raw body). */
uploadsRouter.put(
  "/clips/:id/file",
  raw({ type: () => true, limit: uploadRules.maxBytes }),
  async (req, res) => {
    try {
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
      if (body.length > uploadRules.maxBytes) {
        res.status(413).json({ error: "oversized_file", message: `File exceeds the ${uploadRules.maxLabel} limit.` });
        return;
      }

      await getStorage().put(clip.storageKey, body, clip.contentType);
      const updated = markUploaded(clip.id, body.length);
      res.status(200).json({ clipId: updated.id, status: updated.status, storedBytes: updated.storedBytes });
    } catch (err) {
      if (err instanceof ClipStoreError) {
        res.status(err.httpStatus).json({ error: err.code, message: err.message });
        return;
      }
      throw err;
    }
  },
);
