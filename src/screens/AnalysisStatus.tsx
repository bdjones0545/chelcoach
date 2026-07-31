/**
 * Durable analysis status experience (Step 7).
 * Route `/analysis/:applicationRequestId` is the recovery key.
 * Backend Postgres job remains authoritative — browser never invents status.
 */
import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import AnalysisStageIndicator from "../components/AnalysisStageIndicator";
import BottomNav from "../components/BottomNav";
import Button from "../components/Button";
import GlassPanel from "../components/GlassPanel";
import Icon from "../components/Icon";
import TopAppBar from "../components/TopAppBar";
import {
  cancelAnalysis,
  submitProviderPlayerConfirmation,
} from "../lib/analysisClient";
import {
  clientErrorUserMessage,
  isAnalysisApiError,
  type AnalysisClientError,
} from "../lib/analysisClientErrors";
import type { AnalysisJobView } from "../lib/analysisJobView";
import {
  analysisReportPath,
  analysisStatusPath,
  parseApplicationRequestIdParam,
} from "../lib/analysisRequestId";
import { emitAnalysisTelemetry } from "../lib/analysisClientTelemetry";
import { createAnalysisPollingController } from "../lib/analysisStatusPoller";
import {
  analysisStagesForStatus,
  getAnalysisStatusPresentation,
} from "../lib/analysisStatusPresentation";
import { getPlayerIdentification } from "../lib/playerIdentificationApi";
import { USE_BACKEND_REPORTS } from "../lib/apiBase";

const isDevLike =
  import.meta.env.DEV || import.meta.env.MODE === "test" || import.meta.env.MODE === "development";

type CancelUiState =
  | "idle"
  | "requesting_cancellation"
  | "cancellation_pending"
  | "cancelled"
  | "cancellation_failed";

export default function AnalysisStatus() {
  const navigate = useNavigate();
  const routeParams = useParams();
  const [searchParams] = useSearchParams();

  // Durable path param is preferred; legacy `?requestId=` redirects once.
  const parsedRoute = parseApplicationRequestIdParam(routeParams.applicationRequestId);
  const legacyId = searchParams.get("requestId");
  const applicationRequestId = parsedRoute.ok
    ? parsedRoute.applicationRequestId
    : parseApplicationRequestIdParam(legacyId ?? undefined).ok
      ? legacyId
      : null;
  const malformed =
    !parsedRoute.ok &&
    !parseApplicationRequestIdParam(legacyId ?? undefined).ok &&
    Boolean(routeParams.applicationRequestId || legacyId);

  const [job, setJob] = useState<AnalysisJobView | null>(null);
  const [clientError, setClientError] = useState<AnalysisClientError | null>(null);
  const [accessError, setAccessError] = useState<string | null>(
    malformed || !applicationRequestId ? "We could not access this analysis." : null,
  );
  const [cancelUi, setCancelUi] = useState<CancelUiState>("idle");
  const [confirmBusy, setConfirmBusy] = useState(false);
  const [remoteCandidates, setRemoteCandidates] = useState<
    { candidateId: string; displayLabel: string }[]
  >([]);
  const [selectedCandidateId, setSelectedCandidateId] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState<string>("");
  const lastAnnouncedSequence = useRef<number | null>(null);
  const cancelUiRef = useRef<CancelUiState>("idle");
  const pollerRef = useRef<ReturnType<typeof createAnalysisPollingController> | null>(null);
  const reportFocusRef = useRef<HTMLButtonElement | null>(null);
  const reportFocusDone = useRef(false);

  useEffect(() => {
    cancelUiRef.current = cancelUi;
  }, [cancelUi]);

  // Legacy query-param route → durable path.
  useEffect(() => {
    if (parsedRoute.ok) return;
    if (legacyId && parseApplicationRequestIdParam(legacyId).ok) {
      navigate(analysisStatusPath(legacyId), { replace: true });
    }
  }, [parsedRoute.ok, legacyId, navigate]);

  useEffect(() => {
    if (!USE_BACKEND_REPORTS) {
      navigate("/processing");
      return;
    }
    if (!applicationRequestId) return;

    emitAnalysisTelemetry("route_recovery_completed", {
      applicationRequestId,
      reason: "mount",
    });

    const poller = createAnalysisPollingController({
      applicationRequestId,
      onJob: (next) => {
        // Announce only on initial recovery or sequence advances — never equal-sequence refreshes.
        if (
          lastAnnouncedSequence.current === null ||
          next.statusSequence > lastAnnouncedSequence.current
        ) {
          setAnnouncement(next.statusLabel);
          lastAnnouncedSequence.current = next.statusSequence;
        }
        setJob(next);
        setAccessError(null);
        if (next.status === "cancelled") setCancelUi("cancelled");
        else if (cancelUiRef.current === "requesting_cancellation" && !next.terminal) {
          setCancelUi("cancellation_pending");
        }
      },
      onClientError: (err) => {
        if (
          err.type === "session_expired" ||
          err.type === "forbidden" ||
          err.type === "not_found" ||
          err.type === "malformed_id"
        ) {
          setAccessError(clientErrorUserMessage(err));
          setClientError(err);
          return;
        }
        setClientError(err);
      },
      onClearClientError: () => setClientError(null),
    });
    pollerRef.current = poller;
    poller.start();

    return () => {
      poller.dispose();
      pollerRef.current = null;
    };
  }, [applicationRequestId, navigate]);

  // Provider-level confirmation candidates (distinct from Step 3 upload-level confirmation).
  useEffect(() => {
    if (!job?.userActionRequired || !job.uploadId) return;
    if (job.status !== "awaiting_player_confirmation") return;
    let cancelled = false;
    (async () => {
      try {
        const id = await getPlayerIdentification(job.uploadId);
        if (cancelled) return;
        const mapped = id.candidates.map((c) => ({
          candidateId: c.candidateId,
          displayLabel: c.displayLabel,
        }));
        // High-confidence upload IDs may have zero candidates — still need a provider confirm control.
        if (mapped.length === 0) {
          setRemoteCandidates([
            { candidateId: "sim_remote_default", displayLabel: "Confirmed skater" },
          ]);
          setSelectedCandidateId("sim_remote_default");
        } else {
          setRemoteCandidates(mapped);
          setSelectedCandidateId(mapped[0]?.candidateId ?? null);
        }
      } catch {
        setRemoteCandidates([{ candidateId: "sim_remote_default", displayLabel: "Confirmed skater" }]);
        setSelectedCandidateId("sim_remote_default");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [job?.userActionRequired, job?.uploadId, job?.status]);

  useEffect(() => {
    if (job?.reportAvailable && job.status === "completed" && !reportFocusDone.current) {
      reportFocusDone.current = true;
      reportFocusRef.current?.focus();
    }
  }, [job?.reportAvailable, job?.status]);

  const onCancel = async () => {
    if (!applicationRequestId || cancelUi === "requesting_cancellation") return;
    if (!job?.cancellationAvailable) return;
    setCancelUi("requesting_cancellation");
    emitAnalysisTelemetry("cancellation_requested", { applicationRequestId });
    try {
      // Do not optimistically mark cancelled — wait for backend.
      const next = await cancelAnalysis(applicationRequestId, "Cancelled from status screen");
      setJob(next);
      if (next.status === "cancelled" || next.terminal) {
        setCancelUi("cancelled");
        pollerRef.current?.stop();
      } else {
        // Uncertain / pending — continue status refresh.
        setCancelUi("cancellation_pending");
        await pollerRef.current?.refreshNow();
      }
    } catch (err) {
      setCancelUi("cancellation_failed");
      if (isAnalysisApiError(err)) setClientError(err.clientError);
      else {
        setClientError({
          type: "server",
          retryable: true,
          message: err instanceof Error ? err.message : "Cancel failed",
        });
      }
      await pollerRef.current?.refreshNow();
    }
  };

  const onConfirmRemote = async () => {
    if (!applicationRequestId || !selectedCandidateId || confirmBusy) return;
    setConfirmBusy(true);
    setClientError(null);
    try {
      // Provider-level confirmation — never hits upload-level confirm endpoint.
      const next = await submitProviderPlayerConfirmation(applicationRequestId, {
        selectedCandidateId,
      });
      setJob(next);
      lastAnnouncedSequence.current = next.statusSequence;
      setAnnouncement(next.statusLabel);
      // Resume polling only after backend accepts confirmation.
      await pollerRef.current?.refreshNow();
    } catch (err) {
      if (isAnalysisApiError(err)) setClientError(err.clientError);
      else {
        setClientError({
          type: "server",
          retryable: true,
          message: err instanceof Error ? err.message : "Confirmation failed",
        });
      }
    } finally {
      setConfirmBusy(false);
    }
  };

  const onManualRefresh = async () => {
    await pollerRef.current?.refreshNow();
  };

  const presentation = job
    ? getAnalysisStatusPresentation(job.status)
    : null;
  const label = job?.statusLabel || presentation?.label || "Loading";
  const description =
    job?.statusMessage || presentation?.description || "Loading durable analysis status…";
  const showSimulatorBadge = isDevLike && job?.simulatorMode === true;
  const stages = job ? analysisStagesForStatus(job.status) : [];
  const showCancelControl =
    (job?.cancellationAvailable === true ||
      cancelUi === "requesting_cancellation" ||
      cancelUi === "cancellation_pending") &&
    job != null &&
    job.status !== "completed" &&
    !job.terminal;

  const sessionExpired = clientError?.type === "session_expired";
  const connectionWarning =
    clientError &&
    (clientError.type === "network" ||
      clientError.type === "offline" ||
      clientError.type === "invalid_response" ||
      (clientError.type === "server" && clientError.retryable))
      ? clientErrorUserMessage(clientError)
      : null;

  return (
    <div className="min-h-screen bg-background pb-32">
      <TopAppBar />
      <main className="mx-auto max-w-container-max px-4 pt-24 md:px-gutter">
        <div className="mb-8 text-center md:text-left">
          <h1 className="mb-2 font-headline-xl text-[32px] uppercase text-on-surface md:text-headline-xl">
            Analysis status
          </h1>
          <p className="max-w-2xl font-body-lg text-body-lg text-on-surface-variant">
            Tracking your gameplay analysis from the saved job. Refresh-safe — no fake completion bars.
          </p>
          {showSimulatorBadge && (
            <p
              className="mt-2 font-label-sm text-label-sm text-on-surface-variant"
              data-testid="simulator-dev-label"
            >
              Local Scotty simulator
            </p>
          )}
        </div>

        {/* Announcements for meaningful transitions only — not every poll. */}
        <div className="sr-only" role="status" aria-live="polite" aria-atomic="true" data-testid="analysis-live-region">
          {announcement}
        </div>

        {accessError && (
          <div
            className="mb-6 rounded-xl border border-error/30 bg-error/10 p-4"
            role="alert"
            aria-live="assertive"
            data-testid="analysis-access-error"
          >
            <p className="font-body-md text-error">{accessError}</p>
            {sessionExpired ? (
              <Button
                className="mt-3"
                onClick={() => {
                  const returnTo = applicationRequestId
                    ? analysisStatusPath(applicationRequestId)
                    : "/upload";
                  // Supabase Auth: recover via /login while preserving durable analysis route.
                  navigate(`/login`, { state: { from: returnTo } });
                }}
              >
                Restore session
              </Button>
            ) : (
              <Button className="mt-3" variant="ghost" onClick={() => navigate("/upload")}>
                Back to upload
              </Button>
            )}
          </div>
        )}

        {connectionWarning && !accessError && (
          <div
            className="mb-6 rounded-xl border border-white/15 bg-surface-container p-4"
            role="status"
            aria-live="polite"
            data-testid="analysis-connection-warning"
          >
            <p className="font-body-md text-on-surface">{connectionWarning}</p>
            <Button className="mt-3" variant="ghost" onClick={() => void onManualRefresh()}>
              Refresh status
            </Button>
          </div>
        )}

        {job?.degraded && !accessError && (
          <div
            className="mb-6 rounded-xl border border-white/15 bg-surface-container p-4"
            role="status"
            data-testid="analysis-degraded-banner"
          >
            <p className="font-body-md text-on-surface">
              We are having trouble refreshing the latest status. Your analysis is still saved.
            </p>
          </div>
        )}

        <GlassPanel className="space-y-4 p-6">
          {!job && !accessError ? (
            <div className="flex items-center gap-3">
              <Icon name="progress_activity" className="animate-spin text-primary" />
              <p className="font-body-md text-on-surface">Loading status…</p>
            </div>
          ) : job ? (
            <>
              {stages.length > 0 && <AnalysisStageIndicator stages={stages} />}

              <p className="font-label-sm uppercase text-on-surface-variant">Current status</p>
              <p
                className="font-headline-md text-headline-md uppercase text-on-surface"
                data-testid="analysis-status-label"
              >
                {label}
              </p>
              <p className="font-body-md text-on-surface-variant" data-testid="analysis-status-message">
                {description}
              </p>
              {job.acceptedAt && (
                <p className="font-label-sm text-label-sm text-on-surface-variant">
                  Accepted {new Date(job.acceptedAt).toLocaleString()}
                </p>
              )}

              {/* Provider-level confirmation (Step 7) — distinct from upload-level Step 3. */}
              {job.userActionRequired && job.status === "awaiting_player_confirmation" && (
                <div
                  className="space-y-3 rounded-lg border border-primary/30 bg-primary/5 p-4"
                  data-testid="provider-confirmation-panel"
                >
                  <p className="font-body-md text-on-surface">
                    Action required: confirm which player you controlled.
                  </p>
                  <div
                    role="radiogroup"
                    aria-label="Remote confirmation candidates"
                    className="space-y-2"
                  >
                    {remoteCandidates.map((c) => (
                      <button
                        key={c.candidateId}
                        type="button"
                        role="radio"
                        aria-checked={selectedCandidateId === c.candidateId}
                        className={`w-full rounded-lg border p-3 text-left ${
                          selectedCandidateId === c.candidateId
                            ? "border-primary bg-primary/10"
                            : "border-white/10"
                        }`}
                        onClick={() => setSelectedCandidateId(c.candidateId)}
                      >
                        {c.displayLabel}
                      </button>
                    ))}
                  </div>
                  <Button disabled={!selectedCandidateId || confirmBusy} onClick={() => void onConfirmRemote()}>
                    Confirm player and continue
                  </Button>
                </div>
              )}

              {job.reportAvailable && job.terminal && job.status === "completed" && (
                <div className="space-y-3">
                  <p className="font-body-md text-tertiary">Coaching report ready.</p>
                  <Button
                    ref={reportFocusRef}
                    data-testid="view-coaching-report"
                    onClick={() => navigate(analysisReportPath(job.applicationRequestId))}
                  >
                    View coaching report
                  </Button>
                </div>
              )}

              {job.terminal && job.status === "failed" && (
                <div className="space-y-3" data-testid="analysis-failed-panel">
                  <p className="font-body-md text-error">
                    {job.error?.message || "Analysis failed. Try uploading again."}
                  </p>
                  <Button onClick={() => navigate("/upload")}>Try another clip</Button>
                  <Button variant="ghost" onClick={() => navigate("/player-confirmation")}>
                    Review player information
                  </Button>
                </div>
              )}

              {job.terminal && job.status === "cancelled" && (
                <div className="space-y-3" data-testid="analysis-cancelled-panel">
                  <p className="font-body-md text-on-surface-variant">Analysis cancelled.</p>
                  <Button onClick={() => navigate("/upload")}>Upload again</Button>
                </div>
              )}

              {cancelUi === "cancellation_pending" && !job.terminal && (
                <p className="font-body-md text-on-surface-variant" data-testid="cancellation-pending">
                  Cancellation requested. Waiting for confirmation…
                </p>
              )}

              {cancelUi === "cancellation_failed" && (
                <p className="font-body-md text-error" role="alert">
                  Cancellation could not be confirmed. Your analysis status is unchanged.
                </p>
              )}

              {showCancelControl && (
                <Button
                  variant="ghost"
                  disabled={
                    cancelUi === "requesting_cancellation" || cancelUi === "cancellation_pending"
                  }
                  onClick={() => void onCancel()}
                  data-testid="cancel-analysis"
                >
                  {cancelUi === "requesting_cancellation"
                    ? "Cancelling…"
                    : cancelUi === "cancellation_pending"
                      ? "Cancellation pending…"
                      : "Cancel analysis"}
                </Button>
              )}

              {!job.terminal && (
                <Button variant="ghost" onClick={() => void onManualRefresh()} data-testid="manual-refresh">
                  Refresh status
                </Button>
              )}
            </>
          ) : null}
        </GlassPanel>
      </main>
      <BottomNav active="film" />
    </div>
  );
}
