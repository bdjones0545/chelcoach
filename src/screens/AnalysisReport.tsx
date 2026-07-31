/**
 * Step 7 basic report shell — durable route recovery.
 * Full coaching report redesign is Step 8.
 */
import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import BottomNav from "../components/BottomNav";
import Button from "../components/Button";
import GlassPanel from "../components/GlassPanel";
import TopAppBar from "../components/TopAppBar";
import { getAnalysisReport, getAnalysisStatus } from "../lib/analysisClient";
import {
  clientErrorUserMessage,
  isAnalysisApiError,
} from "../lib/analysisClientErrors";
import {
  analysisStatusPath,
  parseApplicationRequestIdParam,
} from "../lib/analysisRequestId";
import { USE_BACKEND_REPORTS } from "../lib/apiBase";
import type { ScottyReport } from "../../shared/scotty/report";

export default function AnalysisReport() {
  const navigate = useNavigate();
  const params = useParams();
  const parsed = parseApplicationRequestIdParam(params.applicationRequestId);
  const applicationRequestId = parsed.ok ? parsed.applicationRequestId : null;

  const [report, setReport] = useState<ScottyReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!USE_BACKEND_REPORTS) {
      navigate("/scorecard");
      return;
    }
    if (!applicationRequestId) {
      setError("We could not access this analysis.");
      setLoading(false);
      return;
    }

    let cancelled = false;
    const controller = new AbortController();

    (async () => {
      try {
        const job = await getAnalysisStatus(applicationRequestId, controller.signal);
        if (cancelled) return;
        if (!job.reportAvailable || job.status !== "completed") {
          navigate(analysisStatusPath(applicationRequestId), { replace: true });
          return;
        }
        const next = await getAnalysisReport(applicationRequestId, controller.signal);
        if (cancelled) return;
        setReport(next);
        setError(null);
      } catch (err) {
        if (cancelled) return;
        if (isAnalysisApiError(err)) {
          if (err.clientError.type === "server" && err.clientError.code === "REPORT_NOT_READY") {
            navigate(analysisStatusPath(applicationRequestId), { replace: true });
            return;
          }
          setError(clientErrorUserMessage(err.clientError));
        } else {
          setError(err instanceof Error ? err.message : "Failed to load report.");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [applicationRequestId, navigate]);

  return (
    <div className="min-h-screen bg-background pb-32">
      <TopAppBar />
      <main className="mx-auto max-w-container-max px-4 pt-24 md:px-gutter">
        <div className="mb-8 text-center md:text-left">
          <h1 className="mb-2 font-headline-xl text-[32px] uppercase text-on-surface md:text-headline-xl">
            Coaching report
          </h1>
          <p className="max-w-2xl font-body-lg text-body-lg text-on-surface-variant">
            Persisted analysis report. Full report experience arrives in a later step.
          </p>
        </div>

        {error && (
          <div className="mb-6 rounded-xl border border-error/30 bg-error/10 p-4" role="alert">
            <p className="font-body-md text-error">{error}</p>
            {applicationRequestId && (
              <Button
                className="mt-3"
                variant="ghost"
                onClick={() => navigate(analysisStatusPath(applicationRequestId))}
              >
                Back to analysis status
              </Button>
            )}
          </div>
        )}

        <GlassPanel className="space-y-4 p-6" data-testid="analysis-report-shell">
          {loading && <p className="font-body-md text-on-surface">Loading report…</p>}
          {!loading && report && (
            <>
              <p className="font-label-sm uppercase text-on-surface-variant">Report ready</p>
              <p
                className="font-headline-md text-headline-md uppercase text-on-surface"
                data-testid="analysis-report-headline"
              >
                Gameplay coaching summary
              </p>
              {report.strengths[0] && (
                <p className="font-body-md text-on-surface-variant">{report.strengths[0]}</p>
              )}
              {report.priorityImprovements[0] && (
                <p className="font-body-md text-on-surface-variant">
                  Focus: {report.priorityImprovements[0]}
                </p>
              )}
              <p className="font-label-sm text-label-sm text-on-surface-variant">
                Report {report.reportId}
              </p>
              <div className="flex flex-wrap gap-3">
                <Button onClick={() => navigate("/scorecard")}>Continue to scorecard</Button>
                {applicationRequestId && (
                  <Link
                    className="inline-flex items-center font-label-sm text-primary underline"
                    to={analysisStatusPath(applicationRequestId)}
                  >
                    Analysis status
                  </Link>
                )}
              </div>
            </>
          )}
        </GlassPanel>
      </main>
      <BottomNav active="film" />
    </div>
  );
}
