/**
 * Drizzle schema — ChelCoach backend (Phase 0).
 *
 * Minimal tables to support the upload → job → analysis loop. No auth yet:
 * `sessions` is an anonymous device/session placeholder. The `analyses.report`
 * column stores the full Analysis Contract as JSONB (typed), so the UI can
 * consume it directly.
 */
import { bigint, integer, jsonb, pgEnum, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import type { AnalysisReport } from "../contract";

export const clipStatusEnum = pgEnum("clip_status", [
  "uploading",
  "queued",
  "extracting",
  "analyzing",
  "complete",
  "failed",
]);

export const jobStatusEnum = pgEnum("job_status", [
  "queued",
  "extracting",
  "analyzing",
  "complete",
  "failed",
]);

/** Anonymous session (no auth in v1). Real accounts arrive in a later phase. */
export const sessions = pgTable("sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

/** One uploaded gameplay clip. */
export const clips = pgTable("clips", {
  id: uuid("id").primaryKey().defaultRandom(),
  sessionId: uuid("session_id")
    .notNull()
    .references(() => sessions.id, { onDelete: "cascade" }),
  storageKey: text("storage_key").notNull(),
  filename: text("filename").notNull(),
  contentType: text("content_type").notNull(),
  sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
  durationSeconds: integer("duration_seconds"),
  status: clipStatusEnum("status").notNull().default("uploading"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

/** One analysis job per clip (Postgres-backed queue; a poller claims `queued` rows). */
export const analysisJobs = pgTable("analysis_jobs", {
  id: uuid("id").primaryKey().defaultRandom(),
  clipId: uuid("clip_id")
    .notNull()
    .unique()
    .references(() => clips.id, { onDelete: "cascade" }),
  status: jobStatusEnum("status").notNull().default("queued"),
  phaseProgress: integer("phase_progress").notNull().default(0),
  attempts: integer("attempts").notNull().default(0),
  errorCode: text("error_code"),
  errorMessage: text("error_message"),
  claimedAt: timestamp("claimed_at", { withTimezone: true }),
  startedAt: timestamp("started_at", { withTimezone: true }),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

/** The finished report (Analysis Contract) plus cost/telemetry columns. */
export const analyses = pgTable("analyses", {
  id: uuid("id").primaryKey().defaultRandom(),
  clipId: uuid("clip_id")
    .notNull()
    .unique()
    .references(() => clips.id, { onDelete: "cascade" }),
  report: jsonb("report").$type<AnalysisReport>().notNull(),
  model: text("model"),
  tokensIn: integer("tokens_in"),
  tokensOut: integer("tokens_out"),
  costCents: integer("cost_cents"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export type ClipRow = typeof clips.$inferSelect;
export type AnalysisJobRow = typeof analysisJobs.$inferSelect;
export type AnalysisRow = typeof analyses.$inferSelect;
