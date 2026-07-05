/**
 * In-memory clip store (Phase 1 static loop).
 *
 * No database, storage, or persistence yet — this proves the contract-driven
 * upload → status → report loop end to end. Replaced by the Postgres-backed store +
 * job queue in the next phase. State resets on server restart.
 */
import { randomUUID } from "node:crypto";
import type { AnalysisReport, ClipStatus } from "./contract";
import { sampleReport } from "./data/sampleReport";

export interface ClipRecord {
  id: string;
  jobId: string;
  status: ClipStatus;
  phaseProgress: number;
  report?: AnalysisReport;
  createdAt: string;
}

const clips = new Map<string, ClipRecord>();

/**
 * Simulate committing an uploaded clip. In Phase 1 the analysis is instant and
 * deterministic: the clip is marked `complete` with the sample report attached.
 * Idempotent — re-committing the same id returns the existing record.
 */
export function commitClip(id: string): ClipRecord {
  const existing = clips.get(id);
  if (existing) return existing;

  const record: ClipRecord = {
    id,
    jobId: randomUUID(),
    status: "complete",
    phaseProgress: 100,
    report: sampleReport,
    createdAt: new Date().toISOString(),
  };
  clips.set(id, record);
  return record;
}

export function getClip(id: string): ClipRecord | undefined {
  return clips.get(id);
}
