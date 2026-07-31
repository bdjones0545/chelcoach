/**
 * Local Zod validation of untrusted model output against the shared contract.
 */
import { ZodError } from "zod";
import { analysisReportSchema, type AnalysisReport } from "../contract";
import { AiAnalysisError } from "./errors";

export function validateAnalysisReport(raw: unknown): AnalysisReport {
  try {
    // Strip unknown keys at the top level via strip (Zod default) — nested
    // objects also strip unknown keys. Out-of-range / missing required fail.
    return analysisReportSchema.parse(raw);
  } catch (err) {
    if (err instanceof ZodError) {
      const issue = err.issues[0];
      const path = issue ? issue.path.join(".") : "";
      throw new AiAnalysisError(
        "AI_RESPONSE_INVALID",
        `schema: ${path} ${issue?.message ?? "invalid"}`.trim(),
        { retryable: false },
      );
    }
    throw new AiAnalysisError("AI_RESPONSE_INVALID", "validation failed", { retryable: false });
  }
}
