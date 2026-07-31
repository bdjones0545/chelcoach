/**
 * Typed analysis API client (Step 7).
 * Shared-schema validation, abort signals, normalized safe errors.
 * No provider configuration. No raw response leakage.
 */
import {
  analysisReportResponseSchema,
  type AnalysisReportResponse,
} from "../../shared/scotty/report-envelope";
import { API_BASE_URL } from "./apiBase";
import { ensureOwnerSession } from "./scottyUploadApi";
import {
  AnalysisApiError,
  normalizeAnalysisHttpError,
  normalizeTransportError,
} from "./analysisClientErrors";
import { parseAnalysisStatusResponse, type AnalysisJobView } from "./analysisJobView";
import { isValidApplicationRequestId } from "./analysisRequestId";

export type AnalysisStatusApi = {
  getAnalysisStatus: (
    applicationRequestId: string,
    signal?: AbortSignal,
  ) => Promise<AnalysisJobView>;
};

async function authHeaders(): Promise<HeadersInit> {
  const token = await ensureOwnerSession();
  return {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    accept: "application/json",
  };
}

function assertRequestId(applicationRequestId: string): void {
  if (!isValidApplicationRequestId(applicationRequestId)) {
    throw new AnalysisApiError({
      type: "malformed_id",
      retryable: false,
      message: "We could not access this analysis.",
    });
  }
}

async function readJsonBody(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

function rejectUnsafeLeak(body: unknown): void {
  const json = JSON.stringify(body ?? {});
  if (
    json.includes("SCOTTY_BASE_URL") ||
    json.includes("scottyBaseUrl") ||
    json.includes("idempotencyKey") ||
    json.includes("requestFingerprint") ||
    json.includes("storageObjectKey")
  ) {
    throw new AnalysisApiError({
      type: "invalid_response",
      retryable: true,
      message: "Received an invalid analysis response.",
    });
  }
}

export async function getAnalysisStatus(
  applicationRequestId: string,
  signal?: AbortSignal,
): Promise<AnalysisJobView> {
  assertRequestId(applicationRequestId);
  const online = typeof navigator === "undefined" ? true : navigator.onLine !== false;
  try {
    const res = await fetch(`${API_BASE_URL}/api/analysis/${applicationRequestId}`, {
      headers: await authHeaders(),
      signal,
      cache: "no-store",
    });
    const body = await readJsonBody(res);
    if (!res.ok) {
      throw normalizeAnalysisHttpError(
        res.status,
        body as { error?: string; message?: string; retryable?: boolean } | null,
        online,
      );
    }
    rejectUnsafeLeak(body);
    return parseAnalysisStatusResponse(body);
  } catch (err) {
    if (err instanceof AnalysisApiError) throw err;
    throw normalizeTransportError(err, online);
  }
}

export async function getAnalysisReport(
  applicationRequestId: string,
  signal?: AbortSignal,
): Promise<AnalysisReportResponse> {
  assertRequestId(applicationRequestId);
  const online = typeof navigator === "undefined" ? true : navigator.onLine !== false;
  try {
    const res = await fetch(`${API_BASE_URL}/api/analysis/${applicationRequestId}/report`, {
      headers: await authHeaders(),
      signal,
      cache: "no-store",
    });
    const body = await readJsonBody(res);
    if (!res.ok) {
      throw normalizeAnalysisHttpError(
        res.status,
        body as { error?: string; message?: string; retryable?: boolean } | null,
        online,
      );
    }
    rejectUnsafeLeak(body);
    const parsed = analysisReportResponseSchema.safeParse(body);
    if (!parsed.success) {
      throw new AnalysisApiError({
        type: "invalid_report_response",
        retryable: false,
        message: "Your coaching report could not be displayed safely.",
      });
    }
    return parsed.data;
  } catch (err) {
    if (err instanceof AnalysisApiError) throw err;
    throw normalizeTransportError(err, online);
  }
}

export async function cancelAnalysis(
  applicationRequestId: string,
  reason?: string,
  signal?: AbortSignal,
): Promise<AnalysisJobView> {
  assertRequestId(applicationRequestId);
  const online = typeof navigator === "undefined" ? true : navigator.onLine !== false;
  try {
    const res = await fetch(`${API_BASE_URL}/api/analysis/${applicationRequestId}/cancel`, {
      method: "POST",
      headers: await authHeaders(),
      body: JSON.stringify(reason ? { reason } : {}),
      signal,
      cache: "no-store",
    });
    const body = await readJsonBody(res);
    if (!res.ok) {
      throw normalizeAnalysisHttpError(
        res.status,
        body as { error?: string; message?: string; retryable?: boolean } | null,
        online,
      );
    }
    rejectUnsafeLeak(body);
    return parseAnalysisStatusResponse(body);
  } catch (err) {
    if (err instanceof AnalysisApiError) throw err;
    throw normalizeTransportError(err, online);
  }
}

export async function submitProviderPlayerConfirmation(
  applicationRequestId: string,
  payload: { selectedCandidateId: string },
  signal?: AbortSignal,
): Promise<AnalysisJobView> {
  assertRequestId(applicationRequestId);
  const online = typeof navigator === "undefined" ? true : navigator.onLine !== false;
  try {
    const res = await fetch(
      `${API_BASE_URL}/api/analysis/${applicationRequestId}/player-confirmation`,
      {
        method: "POST",
        headers: await authHeaders(),
        body: JSON.stringify({ selectedCandidateId: payload.selectedCandidateId }),
        signal,
        cache: "no-store",
      },
    );
    const body = await readJsonBody(res);
    if (!res.ok) {
      throw normalizeAnalysisHttpError(
        res.status,
        body as { error?: string; message?: string; retryable?: boolean } | null,
        online,
      );
    }
    rejectUnsafeLeak(body);
    return parseAnalysisStatusResponse(body);
  } catch (err) {
    if (err instanceof AnalysisApiError) throw err;
    throw normalizeTransportError(err, online);
  }
}

/** Default injectable API surface for the polling controller. */
export const defaultAnalysisStatusApi: AnalysisStatusApi = {
  getAnalysisStatus,
};
