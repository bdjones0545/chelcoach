/**
 * In-memory clip store (Phase 2).
 *
 * Tracks real uploaded clips through their lifecycle (uploading → queued → complete)
 * plus metadata + storage key. Still no database — swapped for the Postgres/Drizzle
 * store in a later phase. State resets on server restart.
 *
 * Phase 2 wires real upload + object storage; there is still no AI analysis, so
 * `commit` attaches the deterministic sample report (the existing static/mock report).
 */
import { randomUUID } from "node:crypto";
import { extname } from "node:path";
import type { AnalysisReport, ClipStatus } from "./contract";
import { uploadRules } from "./contract";
import { sampleReport } from "./data/sampleReport";

const allowedExt = new Set<string>(uploadRules.acceptExtensions);
function storageKeyFor(id: string, filename: string): string {
  const ext = extname(filename).toLowerCase();
  return `clips/${id}/source${allowedExt.has(ext) ? ext : ".mp4"}`;
}

export interface ClipRecord {
  id: string;
  filename: string;
  contentType: string;
  sizeBytes: number; // declared at init
  storedBytes?: number; // actual bytes written to storage
  storageKey: string;
  status: ClipStatus;
  jobId?: string;
  report?: AnalysisReport;
  createdAt: string;
  updatedAt: string;
}

/** Store error carrying an HTTP status + machine code for the route layer. */
export class ClipStoreError extends Error {
  constructor(
    public httpStatus: number,
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = "ClipStoreError";
  }
}

const clips = new Map<string, ClipRecord>();
const now = () => new Date().toISOString();

export interface NewClipInput {
  filename: string;
  contentType: string;
  sizeBytes: number;
}

/** Create a clip at upload-init time (status "uploading"). Derives the storage key. */
export function createClip(input: NewClipInput): ClipRecord {
  const id = randomUUID();
  const record: ClipRecord = {
    id,
    filename: input.filename,
    contentType: input.contentType,
    sizeBytes: input.sizeBytes,
    storageKey: storageKeyFor(id, input.filename),
    status: "uploading",
    createdAt: now(),
    updatedAt: now(),
  };
  clips.set(id, record);
  return record;
}

export function getClip(id: string): ClipRecord | undefined {
  return clips.get(id);
}

/** Mark a clip's bytes as stored (status "queued" = uploaded, ready to commit). */
export function markUploaded(id: string, storedBytes: number): ClipRecord {
  const clip = clips.get(id);
  if (!clip) throw new ClipStoreError(404, "not_found", "No such clip.");
  if (clip.status !== "uploading") {
    throw new ClipStoreError(409, "invalid_state", `Clip is "${clip.status}", not awaiting upload.`);
  }
  clip.storedBytes = storedBytes;
  clip.status = "queued";
  clip.updatedAt = now();
  return clip;
}

/**
 * Finalize a clip. Phase 2: no real analysis, so a committed clip gets the deterministic
 * sample report and becomes "complete".
 *
 * Back-compat with the static loop: committing an id that was never init'd (e.g. the demo
 * clip) synthesizes a completed record so the frontend read-flag path keeps working.
 */
export function commitClip(id: string): ClipRecord {
  const existing = clips.get(id);

  if (!existing) {
    const demo: ClipRecord = {
      id,
      filename: "demo.mp4",
      contentType: "video/mp4",
      sizeBytes: 0,
      storageKey: `clips/${id}/source.mp4`,
      status: "complete",
      jobId: randomUUID(),
      report: sampleReport,
      createdAt: now(),
      updatedAt: now(),
    };
    clips.set(id, demo);
    return demo;
  }

  if (existing.status === "complete") return existing;
  if (existing.status !== "queued") {
    throw new ClipStoreError(409, "no_file", "Clip has no uploaded file to commit yet.");
  }

  existing.status = "complete";
  existing.report = sampleReport;
  existing.jobId = existing.jobId ?? randomUUID();
  existing.updatedAt = now();
  return existing;
}
