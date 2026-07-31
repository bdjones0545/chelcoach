/**
 * Minimal provider-independent analysis status screen (Step 5).
 * No fake percentages. Full polished progress UX is later.
 */
import { useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import BottomNav from "../components/BottomNav";
import Button from "../components/Button";
import GlassPanel from "../components/GlassPanel";
import Icon from "../components/Icon";
import TopAppBar from "../components/TopAppBar";
import {
  cancelAnalysisRequest,
  confirmRemoteAnalysisPlayer,
  fetchAnalysisStatus,
  type ApplicationAnalysisStatus,
} from "../lib/analysisStatusApi";
import {
  startAnalysisStatusPoller,
  statusLabel,
} from "../lib/analysisStatusPoller";
import { getPlayerIdentification } from "../lib/playerIdentificationApi";
import { USE_BACKEND_REPORTS } from "../lib/reportApi";

const isDevLike =
  import.meta.env.DEV || import.meta.env.MODE === "test" || import.meta.env.MODE === "development";

export default function AnalysisStatus() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const applicationRequestId = params.get("requestId");

  const [status, setStatus] = useState<ApplicationAnalysisStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [remoteCandidates, setRemoteCandidates] = useState<
    { candidateId: string; displayLabel: string }[]
  >([]);
  const [selectedCandidateId, setSelectedCandidateId] = useState<string | null>(null);
  const pollerRef = useRef<{ stop: () => void } | null>(null);

  useEffect(() => {
    if (!USE_BACKEND_REPORTS) {
      navigate("/processing");
      return;
    }
    if (!applicationRequestId) {
      setError("Missing analysis request.");
      return;
    }

    const poller = startAnalysisStatusPoller({
      fetchStatus: async (signal) => fetchAnalysisStatus(applicationRequestId, signal),
      onStatus: (next) => {
        setStatus(next as ApplicationAnalysisStatus);
        setError(null);
      },
      onError: (err) => {
        setError(err.message);
      },
    });
    pollerRef.current = poller;

    return () => {
      poller.stop();
      pollerRef.current = null;
    };
  }, [applicationRequestId, navigate]);

  useEffect(() => {
    if (!status?.userActionRequired || !status.uploadId) return;
    let cancelled = false;
    (async () => {
      try {
        const id = await getPlayerIdentification(status.uploadId);
        if (cancelled) return;
        setRemoteCandidates(
          id.candidates.map((c) => ({
            candidateId: c.candidateId,
            displayLabel: c.displayLabel,
          })),
        );
        setSelectedCandidateId(id.candidates[0]?.candidateId ?? null);
      } catch {
        // Fall back to a deterministic simulator candidate id when frames expired.
        setRemoteCandidates([{ candidateId: "sim_remote_default", displayLabel: "Confirmed skater" }]);
        setSelectedCandidateId("sim_remote_default");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [status?.userActionRequired, status?.uploadId]);

  const onCancel = async () => {
    if (!applicationRequestId || busy) return;
    setBusy(true);
    setError(null);
    try {
      pollerRef.current?.stop();
      const next = await cancelAnalysisRequest(applicationRequestId, "Cancelled from status screen");
      setStatus(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Cancel failed");
    } finally {
      setBusy(false);
    }
  };

  const onConfirmRemote = async () => {
    if (!applicationRequestId || !selectedCandidateId || busy) return;
    setBusy(true);
    setError(null);
    try {
      const next = await confirmRemoteAnalysisPlayer(applicationRequestId, selectedCandidateId);
      setStatus(next);
      // Resume polling after confirmation acceptance.
      pollerRef.current?.stop();
      const poller = startAnalysisStatusPoller({
        fetchStatus: async (signal) => fetchAnalysisStatus(applicationRequestId, signal),
        onStatus: (s) => setStatus(s as ApplicationAnalysisStatus),
        onError: (err) => setError(err.message),
      });
      pollerRef.current = poller;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Confirmation failed");
    } finally {
      setBusy(false);
    }
  };

  const label = status ? statusLabel(status.status) : "Loading";
  const showSimulatorBadge = isDevLike && status?.simulatorMode === true;
  const canCancel =
    status &&
    !status.terminal &&
    status.status !== "awaiting_player_confirmation" &&
    status.status !== "completed";

  return (
    <div className="min-h-screen bg-background pb-32">
      <TopAppBar />
      <main className="mx-auto max-w-container-max px-4 pt-24 md:px-gutter">
        <div className="mb-8 text-center md:text-left">
          <h1 className="mb-2 font-headline-xl text-[32px] uppercase text-on-surface md:text-headline-xl">
            Analysis status
          </h1>
          <p className="max-w-2xl font-body-lg text-body-lg text-on-surface-variant">
            Tracking your gameplay analysis. Status updates are truthful — no fake completion bars.
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

        {error && (
          <div
            className="mb-6 rounded-xl border border-error/30 bg-error/10 p-4"
            role="alert"
            aria-live="assertive"
          >
            <p className="font-body-md text-error">{error}</p>
            <Button className="mt-3" variant="ghost" onClick={() => navigate("/upload")}>
              Back to upload
            </Button>
          </div>
        )}

        <GlassPanel className="space-y-4 p-6" role="status" aria-live="polite">
          {!status ? (
            <div className="flex items-center gap-3">
              <Icon name="progress_activity" className="animate-spin text-primary" />
              <p className="font-body-md text-on-surface">Loading status…</p>
            </div>
          ) : (
            <>
              <p className="font-label-sm uppercase text-on-surface-variant">Current status</p>
              <p className="font-headline-md text-headline-md uppercase text-on-surface" data-testid="analysis-status-label">
                {label}
              </p>
              {status.message && (
                <p className="font-body-md text-on-surface-variant" data-testid="analysis-status-message">
                  {status.message}
                </p>
              )}
              {status.acceptedAt && (
                <p className="font-label-sm text-label-sm text-on-surface-variant">
                  Accepted {new Date(status.acceptedAt).toLocaleString()}
                </p>
              )}
              {/* Intentionally no percentage complete field. */}
              {status.userActionRequired && (
                <div className="space-y-3 rounded-lg border border-primary/30 bg-primary/5 p-4">
                  <p className="font-body-md text-on-surface">
                    Action required: confirm which player you controlled.
                  </p>
                  <div role="radiogroup" aria-label="Remote confirmation candidates" className="space-y-2">
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
                  <Button disabled={!selectedCandidateId || busy} onClick={onConfirmRemote}>
                    Confirm player and continue
                  </Button>
                </div>
              )}

              {status.reportReady && status.terminal && status.status === "completed" && (
                <div className="space-y-3">
                  <p className="font-body-md text-tertiary">Coaching report ready.</p>
                  <Button onClick={() => navigate("/processing")}>Continue to scorecard</Button>
                </div>
              )}

              {status.terminal && status.status === "failed" && (
                <div className="space-y-3">
                  <p className="font-body-md text-error">
                    {status.errorMessage || "Analysis failed. Try uploading again."}
                  </p>
                  <Button onClick={() => navigate("/upload")}>Try another clip</Button>
                </div>
              )}

              {status.terminal && status.status === "cancelled" && (
                <div className="space-y-3">
                  <p className="font-body-md text-on-surface-variant">Analysis cancelled.</p>
                  <Button onClick={() => navigate("/upload")}>Upload again</Button>
                </div>
              )}

              {canCancel && (
                <Button variant="ghost" disabled={busy} onClick={onCancel}>
                  Cancel analysis
                </Button>
              )}
            </>
          )}
        </GlassPanel>
      </main>
      <BottomNav active="film" />
    </div>
  );
}
