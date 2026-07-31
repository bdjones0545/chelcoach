/**
 * In-memory clip store.
 *
 * Lifecycle (real uploads):
 *   uploading → queued (bytes stored) → commit keeps queued + enqueues job
 *   → extracting → analyzing → complete | failed
 *
 * Demo commit (unknown id, e.g. static-demo-clip): still completes immediately
 * with the sample report — intentional demo path, no FFmpeg / no AI key.
 *
 * State resets on server restart. No database yet.
 */
import { randomUUID } from "node:crypto";
import { extname } from "node:path";
import type { AnalysisJobStage, AnalysisReport, ClipStatus, ErrorCode } from "./contract";
import { uploadRules } from "./contract";
import type { AnalysisProvenance, ReportSource } from "./ai/analyze";
import { sampleReport } from "./data/sampleReport";
import type { ExtractionResult } from "./media/types";

const allowedExt = new Set<string>(uploadRules.acceptExtensions);
function storageKeyFor(id: string, filename: string): string {
  const ext = extname(filename).toLowerCase();
  return `clips/${id}/source${allowedExt.has(ext) ? ext : ".mp4"}`;
}

export interface ClipRecord {
  id: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  storedBytes?: number;
  storageKey: string;
  status: ClipStatus;
  /** Finer public stage while status === extracting | analyzing. */
  stage?: AnalysisJobStage;
  phaseProgress?: number;
  jobId?: string;
  report?: AnalysisReport;
  errorCode?: ErrorCode;
  errorMessage?: string;
  /** Internal extraction summary retained after workspace cleanup (no frame bytes). */
  extraction?: ExtractionResult;
  /** True while an analysis job is queued or running for this clip. */
  extractionQueued?: boolean;
  /** Internal provenance — not part of the public AnalysisReport. */
  reportSource?: ReportSource;
  provenance?: AnalysisProvenance;
  createdAt: string;
  updatedAt: string;
}

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

export function createClip(input: NewClipInput): ClipRecord {
  const id = randomUUID();
  const record: ClipRecord = {
    id,
    filename: input.filename,
    contentType: input.contentType,
    sizeBytes: input.sizeBytes,
    storageKey: storageKeyFor(id, input.filename),
    status: "uploading",
    stage: "queued",
    phaseProgress: 0,
    createdAt: now(),
    updatedAt: now(),
  };
  clips.set(id, record);
  return record;
}

export function getClip(id: string): ClipRecord | undefined {
  return clips.get(id);
}

export function markUploaded(id: string, storedBytes: number): ClipRecord {
  const clip = clips.get(id);
  if (!clip) throw new ClipStoreError(404, "not_found", "No such clip.");
  if (clip.status !== "uploading") {
    throw new ClipStoreError(409, "invalid_state", `Clip is "${clip.status}", not awaiting upload.`);
  }
  clip.storedBytes = storedBytes;
  clip.status = "queued";
  clip.stage = "queued";
  clip.phaseProgress = 10;
  clip.updatedAt = now();
  return clip;
}

export interface CommitResult {
  clip: ClipRecord;
  /** True when the caller should enqueue analysis (real upload). */
  shouldExtract: boolean;
}

/**
 * Finalize upload. Real clips stay `queued` and signal analysis.
 * Unknown ids synthesize an immediately-completed demo record (no FFmpeg/AI).
 * Idempotent: re-commit of complete/failed/in-flight clips does not restart work.
 */
export function commitClip(id: string): CommitResult {
  const existing = clips.get(id);

  if (!existing) {
    const demo: ClipRecord = {
      id,
      filename: "demo.mp4",
      contentType: "video/mp4",
      sizeBytes: 0,
      storageKey: `clips/${id}/source.mp4`,
      status: "complete",
      stage: "ready",
      phaseProgress: 100,
      jobId: randomUUID(),
      report: sampleReport,
      reportSource: "demo",
      provenance: {
        reportSource: "demo",
        contractVersion: "1",
        rubricVersion: "demo",
        promptVersion: "demo",
        provider: "none",
        model: "none",
        generatedAt: now(),
      },
      createdAt: now(),
      updatedAt: now(),
    };
    clips.set(id, demo);
    return { clip: demo, shouldExtract: false };
  }

  // Terminal or already running — do not create duplicate work / provider charges.
  if (existing.status === "complete" || existing.status === "failed") {
    return { clip: existing, shouldExtract: false };
  }
  if (
    existing.status === "extracting" ||
    existing.status === "analyzing" ||
    existing.extractionQueued
  ) {
    return { clip: existing, shouldExtract: false };
  }
  if (existing.status !== "queued") {
    throw new ClipStoreError(409, "no_file", "Clip has no uploaded file to commit yet.");
  }

  existing.jobId = existing.jobId ?? randomUUID();
  existing.status = "queued";
  existing.stage = "queued";
  existing.phaseProgress = 15;
  existing.extractionQueued = true;
  existing.errorCode = undefined;
  existing.errorMessage = undefined;
  existing.updatedAt = now();
  return { clip: existing, shouldExtract: true };
}

export function beginExtraction(id: string): ClipRecord {
  const clip = clips.get(id);
  if (!clip) throw new ClipStoreError(404, "not_found", "No such clip.");
  if (clip.status === "complete" || clip.status === "failed") return clip;
  clip.status = "extracting";
  clip.stage = "inspecting_video";
  clip.phaseProgress = 20;
  clip.extractionQueued = true;
  clip.updatedAt = now();
  return clip;
}

export function updateJobProgress(
  id: string,
  stage: AnalysisJobStage,
  phaseProgress: number,
  status?: ClipStatus,
): ClipRecord {
  const clip = clips.get(id);
  if (!clip) throw new ClipStoreError(404, "not_found", "No such clip.");
  if (clip.status === "complete" || clip.status === "failed") return clip;
  if (status) clip.status = status;
  else if (stage === "analyzing_gameplay" || stage === "validating_report") {
    clip.status = "analyzing";
  } else if (stage === "inspecting_video" || stage === "extracting_frames") {
    clip.status = "extracting";
  }
  clip.stage = stage;
  clip.phaseProgress = Math.max(0, Math.min(100, phaseProgress));
  clip.updatedAt = now();
  return clip;
}

/** @deprecated Use updateJobProgress — kept for existing call sites during migration. */
export function updateExtractionProgress(
  id: string,
  stage: AnalysisJobStage,
  phaseProgress: number,
  message?: string,
): ClipRecord {
  void message;
  return updateJobProgress(id, stage, phaseProgress);
}

/**
 * Persist extraction metadata only — does NOT mark the job completed.
 * Live completion requires a validated AI report via completeAnalysis.
 */
export function recordExtraction(id: string, extraction: ExtractionResult): ClipRecord {
  const clip = clips.get(id);
  if (!clip) throw new ClipStoreError(404, "not_found", "No such clip.");
  if (clip.status === "complete" || clip.status === "failed") return clip;
  clip.extraction = extraction;
  clip.status = "analyzing";
  clip.stage = "analyzing_gameplay";
  clip.phaseProgress = 58;
  clip.updatedAt = now();
  return clip;
}

/**
 * Legacy helper used by older tests — attaches the deterministic sample report.
 * Not used by the live job path (which must never silently fall back to sample).
 */
export function completeExtraction(id: string, extraction: ExtractionResult): ClipRecord {
  const clip = clips.get(id);
  if (!clip) throw new ClipStoreError(404, "not_found", "No such clip.");
  clip.status = "complete";
  clip.stage = "ready";
  clip.phaseProgress = 100;
  clip.report = sampleReport;
  clip.reportSource = "deterministic_sample";
  clip.extraction = extraction;
  clip.extractionQueued = false;
  clip.errorCode = undefined;
  clip.errorMessage = undefined;
  clip.updatedAt = now();
  return clip;
}

export function completeAnalysis(
  id: string,
  report: AnalysisReport,
  provenance: AnalysisProvenance,
  extraction?: ExtractionResult,
): ClipRecord {
  const clip = clips.get(id);
  if (!clip) throw new ClipStoreError(404, "not_found", "No such clip.");
  // Idempotent: do not overwrite a completed report (guards duplicate charges).
  if (clip.status === "complete" && clip.report) return clip;

  clip.status = "complete";
  clip.stage = "ready";
  clip.phaseProgress = 100;
  clip.report = report;
  clip.reportSource = provenance.reportSource;
  clip.provenance = provenance;
  if (extraction) clip.extraction = extraction;
  clip.extractionQueued = false;
  clip.errorCode = undefined;
  clip.errorMessage = undefined;
  clip.updatedAt = now();
  return clip;
}

export function markFailed(
  id: string,
  errorCode: ErrorCode = "extraction_failed",
  errorMessage = "Analysis failed.",
): ClipRecord {
  const clip = clips.get(id);
  if (!clip) throw new ClipStoreError(404, "not_found", "No such clip.");
  if (clip.status === "complete" && clip.report) return clip;
  clip.status = "failed";
  clip.stage = "failed";
  clip.phaseProgress = 0;
  clip.report = undefined;
  clip.reportSource = undefined;
  clip.provenance = undefined;
  clip.errorCode = errorCode;
  clip.errorMessage = errorMessage;
  clip.extractionQueued = false;
  clip.jobId = clip.jobId ?? randomUUID();
  clip.updatedAt = now();
  return clip;
}

/** Test helper — wipe the in-memory map. */
export function resetStoreForTests(): void {
  clips.clear();
}
