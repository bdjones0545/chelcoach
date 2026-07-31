import { useEffect, useId, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import BottomNav from "../components/BottomNav";
import Button from "../components/Button";
import GlassPanel from "../components/GlassPanel";
import Icon from "../components/Icon";
import TopAppBar from "../components/TopAppBar";
import {
  submitGameplayAnalysis,
  type AnalysisSubmitUiState,
} from "../lib/analysisApi";
import { USE_BACKEND_REPORTS } from "../lib/reportApi";
import {
  confirmPlayer,
  correctIdentification,
  loadFrameObjectUrl,
  noneOfTheAbove,
  readReadyUploadId,
  startPlayerIdentification,
  type PublicPlayerCandidate,
  type PublicPlayerIdentification,
} from "../lib/playerIdentificationApi";

function formatTimestamp(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return `${String(m).padStart(2, "0")}:${s.toFixed(1).padStart(4, "0")}`;
}

function fieldOrNotVisible(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === "" || value === "unknown") return "Not visible";
  return String(value);
}

export default function PlayerConfirmation() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const uploadId = params.get("uploadId") || readReadyUploadId();
  const statusId = useId();

  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<PublicPlayerIdentification | null>(null);
  const [frameIndex, setFrameIndex] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [frameUrls, setFrameUrls] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [showHints, setShowHints] = useState(false);
  const [hintJersey, setHintJersey] = useState("");
  const [hintColor, setHintColor] = useState("");
  const [submitState, setSubmitState] = useState<AnalysisSubmitUiState>("ready_to_submit");
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [acceptedRequestId, setAcceptedRequestId] = useState<string | null>(null);

  const fixture =
    import.meta.env.DEV || import.meta.env.VITE_ALLOW_IDENTITY_FIXTURES === "true"
      ? (params.get("fixture") ?? "low_confidence_multiple_players")
      : undefined;

  useEffect(() => {
    let cancelled = false;
    const urlsToRevoke: string[] = [];

    (async () => {
      if (!USE_BACKEND_REPORTS) {
        // Mock path — keep conversion loop moving without backend.
        navigate("/processing");
        return;
      }
      if (!uploadId) {
        setError("No ready upload found. Upload a clip first.");
        setState("error");
        return;
      }
      try {
        setState("loading");
        const result = await startPlayerIdentification(uploadId, fixture);
        if (cancelled) return;

        if (result.status === "identified") {
          setData(result);
          setState("ready");
          return;
        }
        if (result.status === "confirmed") {
          setData(result);
          setState("ready");
          setSubmitState("ready_to_submit");
          return;
        }

        const urlMap: Record<string, string> = {};
        for (const frame of result.frames) {
          const url = await loadFrameObjectUrl(frame.accessUrl);
          urlsToRevoke.push(url);
          urlMap[frame.frameId] = url;
        }
        if (cancelled) return;
        setFrameUrls(urlMap);
        setData(result);
        setSelectedId(result.candidates[0]?.candidateId ?? null);
        setState("ready");
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Identification failed");
          setState("error");
        }
      }
    })();

    return () => {
      cancelled = true;
      for (const u of urlsToRevoke) URL.revokeObjectURL(u);
    };
  }, [uploadId, fixture, navigate]);

  const activeFrame = data?.frames[frameIndex];
  const candidatesForFrame = useMemo(() => {
    if (!data || !activeFrame) return data?.candidates ?? [];
    const matched = data.candidates.filter((c) => c.representativeFrameId === activeFrame.frameId);
    return matched.length ? matched : data.candidates;
  }, [data, activeFrame]);

  const selected: PublicPlayerCandidate | undefined = data?.candidates.find(
    (c) => c.candidateId === selectedId,
  );

  const onConfirm = async () => {
    if (!uploadId || !selected || !activeFrame) return;
    setBusy(true);
    setError(null);
    try {
      const confirmed = await confirmPlayer(uploadId, {
        selectedCandidateId: selected.candidateId,
        frameId: selected.representativeFrameId,
        confirmedPosition: selected.position,
        confirmedJerseyNumber: selected.jerseyNumber ?? undefined,
        confirmedIndicatorColor: selected.indicatorColor ?? undefined,
      });
      setData(confirmed);
      setSubmitState("ready_to_submit");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Confirmation failed");
    } finally {
      setBusy(false);
    }
  };

  const onAnalyze = async () => {
    if (!uploadId) return;
    if (data?.status !== "identified" && data?.status !== "confirmed") return;
    setSubmitState("submitting");
    setSubmitError(null);
    setBusy(true);
    try {
      const result = await submitGameplayAnalysis(uploadId);
      setAcceptedRequestId(result.applicationRequestId);
      setSubmitState("accepted");
    } catch (err) {
      setSubmitState("submission_failed");
      setSubmitError(err instanceof Error ? err.message : "Analysis submission failed");
    } finally {
      setBusy(false);
    }
  };

  const onCorrect = async () => {
    if (!uploadId) return;
    setBusy(true);
    setError(null);
    try {
      const result = await correctIdentification(uploadId);
      const urlMap: Record<string, string> = { ...frameUrls };
      for (const frame of result.frames) {
        if (!urlMap[frame.frameId]) {
          urlMap[frame.frameId] = await loadFrameObjectUrl(frame.accessUrl);
        }
      }
      setFrameUrls(urlMap);
      setData(result);
      setFrameIndex(0);
      setSelectedId(result.candidates[0]?.candidateId ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Correction failed");
    } finally {
      setBusy(false);
    }
  };

  const onNone = async (requestAdditional: boolean) => {
    if (!uploadId) return;
    setBusy(true);
    setError(null);
    try {
      const jersey = hintJersey.trim() === "" ? undefined : Number(hintJersey);
      const result = await noneOfTheAbove(uploadId, {
        requestAdditionalExtraction: requestAdditional,
        hints: {
          ...(jersey !== undefined && Number.isFinite(jersey) ? { jerseyNumber: jersey } : {}),
          ...(hintColor.trim() ? { indicatorColor: hintColor.trim() } : {}),
        },
      });
      if (result.status === "unresolved") {
        setData(result);
        setError("We couldn't confirm your player. The upload is saved — try again later with clearer footage.");
        return;
      }
      const urlMap: Record<string, string> = {};
      for (const frame of result.frames) {
        urlMap[frame.frameId] = await loadFrameObjectUrl(frame.accessUrl);
      }
      Object.values(frameUrls).forEach((u) => URL.revokeObjectURL(u));
      setFrameUrls(urlMap);
      setData(result);
      setFrameIndex(0);
      setSelectedId(result.candidates[0]?.candidateId ?? null);
      setShowHints(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Request failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen bg-background pb-32">
      <TopAppBar />
      <main className="mx-auto max-w-container-max px-4 pt-24 md:px-gutter">
        <div className="mb-8 text-center md:text-left">
          <h1 className="mb-2 font-headline-xl text-[32px] uppercase text-on-surface md:text-headline-xl">
            Which player are you controlling?
          </h1>
          <p className="max-w-2xl font-body-lg text-body-lg text-on-surface-variant">
            Select your skater so Scotty can analyze only your decisions and positioning.
          </p>
        </div>

        {state === "loading" && (
          <GlassPanel className="flex items-center gap-3 p-6" role="status" aria-live="polite">
            <Icon name="progress_activity" className="animate-spin text-primary" />
            <p className="font-body-md text-on-surface">Checking player identity…</p>
          </GlassPanel>
        )}

        {error && (
          <div
            className="mb-6 flex items-start gap-3 rounded-xl border border-error/30 bg-error/10 p-4"
            role="alert"
            aria-live="assertive"
            id={statusId}
          >
            <Icon name="error" className="mt-0.5 shrink-0 text-error" fill />
            <p className="font-body-md text-on-surface">{error}</p>
          </div>
        )}

        {(data?.status === "identified" || data?.status === "confirmed") && (
          <GlassPanel className="mb-6 space-y-4 p-6">
            <p className="font-body-md text-on-surface" role="status">
              {data.status === "confirmed"
                ? "Controlled player confirmed."
                : `Player identified with ${(data.confidence * 100).toFixed(0)}% confidence`}
              {data.player
                ? ` — ${fieldOrNotVisible(data.player.position)}, jersey ${fieldOrNotVisible(data.player.jerseyNumber)}`
                : ""}
              .
            </p>
            <p className="font-label-sm text-label-sm text-on-surface-variant">{data.retentionNotice}</p>

            {submitState === "accepted" ? (
              <div role="status" aria-live="polite" className="space-y-3">
                <p className="font-body-md text-tertiary">
                  Analysis accepted{acceptedRequestId ? ` (${acceptedRequestId.slice(0, 8)}…)` : ""}.
                  Full progress tracking arrives in a later step.
                </p>
                <Button variant="ghost" onClick={() => navigate("/processing")}>
                  Continue to demo scorecard
                </Button>
              </div>
            ) : (
              <div className="flex flex-wrap gap-3">
                <Button
                  disabled={busy || submitState === "submitting"}
                  onClick={onAnalyze}
                  icon={submitState === "submitting" ? "cloud_upload" : "psychology"}
                >
                  {submitState === "submitting" ? "Submitting…" : "Analyze my gameplay"}
                </Button>
                {data.status === "identified" && (
                  <Button variant="ghost" disabled={busy} onClick={onCorrect}>
                    That is not my player
                  </Button>
                )}
              </div>
            )}

            {submitState === "submission_failed" && submitError && (
              <div className="rounded-lg border border-error/30 bg-error/10 p-3" role="alert">
                <p className="font-body-md text-error">{submitError}</p>
                <Button className="mt-3" variant="ghost" disabled={busy} onClick={onAnalyze}>
                  Try again
                </Button>
              </div>
            )}
            {/* No fake percentage — submission is accept/fail only in Step 4. */}
          </GlassPanel>
        )}

        {data?.status === "confirmation_required" && activeFrame && (
          <div className="grid grid-cols-1 gap-gutter lg:grid-cols-12">
            <div className="lg:col-span-7">
              <GlassPanel className="overflow-hidden p-3">
                <div className="relative aspect-video w-full overflow-hidden rounded-lg bg-surface-container-highest">
                  {frameUrls[activeFrame.frameId] ? (
                    <img
                      src={frameUrls[activeFrame.frameId]}
                      alt={`Gameplay frame at ${formatTimestamp(activeFrame.timestampSec)}`}
                      className="h-full w-full object-contain"
                    />
                  ) : (
                    <div className="flex h-full items-center justify-center font-body-md text-on-surface-variant">
                      Loading frame…
                    </div>
                  )}
                  {selected && selected.representativeFrameId === activeFrame.frameId && (
                    <div
                      className="pointer-events-none absolute border-2 border-primary bg-primary/10"
                      style={{
                        left: `${selected.boundingBox.x * 100}%`,
                        top: `${selected.boundingBox.y * 100}%`,
                        width: `${selected.boundingBox.width * 100}%`,
                        height: `${selected.boundingBox.height * 100}%`,
                      }}
                      aria-hidden
                    />
                  )}
                </div>
                <div className="mt-3 flex items-center justify-between gap-3">
                  <button
                    type="button"
                    className="rounded-lg px-3 py-2 font-label-sm uppercase text-on-surface-variant hover:bg-white/5 disabled:opacity-40"
                    disabled={frameIndex <= 0 || busy}
                    aria-label="Previous representative frame"
                    onClick={() => setFrameIndex((i) => Math.max(0, i - 1))}
                  >
                    Previous frame
                  </button>
                  <span className="font-label-sm text-label-sm text-on-surface-variant">
                    Frame {frameIndex + 1} / {data.frames.length} · {formatTimestamp(activeFrame.timestampSec)}
                  </span>
                  <button
                    type="button"
                    className="rounded-lg px-3 py-2 font-label-sm uppercase text-on-surface-variant hover:bg-white/5 disabled:opacity-40"
                    disabled={frameIndex >= data.frames.length - 1 || busy}
                    aria-label="Next representative frame"
                    onClick={() => setFrameIndex((i) => Math.min(data.frames.length - 1, i + 1))}
                  >
                    Next frame
                  </button>
                </div>
              </GlassPanel>
              <p className="mt-3 font-label-sm text-label-sm text-on-surface-variant">{data.retentionNotice}</p>
            </div>

            <div className="flex flex-col gap-4 lg:col-span-5">
              <div
                role="radiogroup"
                aria-label="Candidate skaters"
                aria-describedby={error ? statusId : undefined}
                className="space-y-3"
              >
                {candidatesForFrame.map((c) => {
                  const selectedCandidate = c.candidateId === selectedId;
                  return (
                    <button
                      key={c.candidateId}
                      type="button"
                      role="radio"
                      aria-checked={selectedCandidate}
                      disabled={busy}
                      onClick={() => setSelectedId(c.candidateId)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          setSelectedId(c.candidateId);
                        }
                      }}
                      className={`w-full rounded-xl border p-4 text-left transition-colors ${
                        selectedCandidate
                          ? "border-primary bg-primary/10"
                          : "border-white/10 bg-surface-container-high/40 hover:border-white/20"
                      }`}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <p className="font-body-md font-bold text-on-surface">{c.displayLabel}</p>
                          <p className="mt-1 font-label-sm text-label-sm text-on-surface-variant">
                            {fieldOrNotVisible(c.indicatorColor)} indicator
                          </p>
                          <p className="font-label-sm text-label-sm text-on-surface-variant">
                            Jersey {fieldOrNotVisible(c.jerseyNumber)} · {fieldOrNotVisible(c.position)}
                          </p>
                          <p className="font-label-sm text-label-sm text-on-surface-variant">
                            {formatTimestamp(c.timestampSec)}
                          </p>
                        </div>
                        {selectedCandidate && (
                          <Icon name="check_circle" className="text-primary" fill aria-hidden />
                        )}
                      </div>
                      <span className="sr-only">
                        {selectedCandidate ? "Selected. " : ""}
                        {c.evidenceSummary}
                      </span>
                    </button>
                  );
                })}
              </div>

              <Button className="h-14 w-full" disabled={!selectedId || busy} onClick={onConfirm}>
                Confirm my player
              </Button>

              <Button
                variant="ghost"
                className="w-full"
                disabled={busy}
                onClick={() => setShowHints((v) => !v)}
              >
                None of these are my player
              </Button>

              {showHints && (
                <GlassPanel className="space-y-3 p-4">
                  <p className="font-body-md text-on-surface-variant">
                    Add a hint or request one more candidate pass. We will not guess.
                  </p>
                  <input
                    type="number"
                    min={0}
                    max={99}
                    value={hintJersey}
                    onChange={(e) => setHintJersey(e.target.value)}
                    placeholder="Jersey number"
                    aria-label="Jersey number hint"
                    className="w-full rounded-lg border border-white/10 bg-surface-container-highest px-3 py-2 font-body-md text-on-surface"
                  />
                  <input
                    type="text"
                    value={hintColor}
                    onChange={(e) => setHintColor(e.target.value)}
                    placeholder="Indicator color"
                    aria-label="Indicator color hint"
                    className="w-full rounded-lg border border-white/10 bg-surface-container-highest px-3 py-2 font-body-md text-on-surface"
                  />
                  {data.additionalExtractionAvailable ? (
                    <Button className="w-full" disabled={busy} onClick={() => onNone(true)}>
                      Try one more pass
                    </Button>
                  ) : (
                    <Button className="w-full" disabled={busy} onClick={() => onNone(false)}>
                      Leave unresolved
                    </Button>
                  )}
                </GlassPanel>
              )}
            </div>
          </div>
        )}

        {data?.status === "unresolved" && (
          <GlassPanel className="p-6">
            <p className="mb-4 font-body-md text-on-surface">
              Controlled player left unresolved. Your upload is preserved — no coaching report was generated.
            </p>
            <Button onClick={() => navigate("/upload")}>Back to upload</Button>
          </GlassPanel>
        )}
      </main>
      <BottomNav active="film" />
    </div>
  );
}
