import { useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import BottomNav from "../components/BottomNav";
import Button from "../components/Button";
import GlassPanel from "../components/GlassPanel";
import Icon from "../components/Icon";
import TopAppBar from "../components/TopAppBar";
import { uploadErrors, uploadRules } from "../data/mockData";
import { useReport } from "../state/ReportContext";
import { USE_BACKEND_REPORTS } from "../lib/reportApi";

const checklist = [
  { title: "AI analyzes positioning", detail: "Real-time heatmaps & gap tracking." },
  { title: "Grades hockey IQ", detail: "Decision-speed and playmaking score." },
  { title: "Finds missed opportunities", detail: "Detects open lanes and passing options." },
  { title: "Builds your coaching report", detail: "Tailored drills based on your mistakes." },
];

function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(0)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}

function isSupported(file: File): boolean {
  const name = file.name.toLowerCase();
  const extOk = uploadRules.acceptExtensions.some((ext) => name.endsWith(ext));
  const mimeOk = uploadRules.acceptMimeTypes.includes(file.type);
  return extOk || mimeOk;
}

export default function Upload() {
  const navigate = useNavigate();
  const { analyzeClip } = useReport();
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);

  const handleFiles = (files: FileList | null) => {
    if (!files || files.length === 0) {
      setFile(null);
      setError(uploadErrors.empty);
      return;
    }
    const picked = files[0];
    if (!isSupported(picked)) {
      setFile(null);
      setError(uploadErrors.unsupported(picked.name));
      return;
    }
    if (picked.size > uploadRules.maxBytes) {
      setFile(null);
      setError(uploadErrors.oversized(picked.name, formatBytes(picked.size)));
      return;
    }
    setError(null);
    setFile(picked);
  };

  const removeFile = () => {
    setFile(null);
    setError(null);
    if (inputRef.current) inputRef.current.value = "";
  };

  // Flag off: keep the mock flow (straight to processing). Flag on: really upload first.
  const startAnalysis = async () => {
    if (!file) return;
    if (!USE_BACKEND_REPORTS) {
      navigate("/processing");
      return;
    }
    setUploading(true);
    setProgress(0);
    setError(null);
    try {
      await analyzeClip(file, setProgress);
      navigate("/processing");
    } catch {
      setError("Upload failed. Check your connection and try again.");
      setUploading(false);
    }
  };

  return (
    <div className="min-h-screen bg-background pb-32">
      <TopAppBar />

      <main className="mx-auto max-w-container-max px-4 pt-24 md:px-gutter">
        <div className="mb-10 text-center md:text-left">
          <h1 className="mb-2 font-headline-xl text-[32px] uppercase text-on-surface md:text-headline-xl">
            Upload Gameplay
          </h1>
          <p className="max-w-2xl font-body-lg text-body-lg text-on-surface-variant">
            Drop in one game clip and get your Chel Rating plus a full skill breakdown in under a minute. No sign-up
            required.
          </p>
        </div>

        <div className="grid grid-cols-1 gap-gutter lg:grid-cols-12">
          {/* Upload zone */}
          <div className="flex flex-col gap-6 lg:col-span-8">
            <div
              role="button"
              tabIndex={0}
              aria-label="Upload a game clip. Accepts MP4 or MOV files up to 2 gigabytes."
              onClick={() => inputRef.current?.click()}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  inputRef.current?.click();
                }
              }}
              onDragEnter={(e) => {
                e.preventDefault();
                setDragActive(true);
              }}
              onDragOver={(e) => e.preventDefault()}
              onDragLeave={() => setDragActive(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragActive(false);
                handleFiles(e.dataTransfer.files);
              }}
              className={`upload-dashed glass-panel group relative flex aspect-video w-full cursor-pointer flex-col items-center justify-center rounded-xl transition-all duration-300 hover:bg-primary/5 ${
                dragActive ? "is-active bg-primary/10" : ""
              }`}
            >
              <input
                ref={inputRef}
                type="file"
                accept={uploadRules.accept}
                aria-label="Choose a game clip to upload"
                className="hidden"
                onChange={(e) => handleFiles(e.target.files)}
              />
              <div className="flex flex-col items-center p-8 text-center">
                <div
                  className={`mb-6 flex h-20 w-20 items-center justify-center rounded-full transition-transform duration-300 group-hover:scale-110 ${
                    file ? "bg-tertiary/10" : "bg-primary/10"
                  }`}
                >
                  <Icon
                    name={file ? "check_circle" : "upload_file"}
                    className={`text-[48px] ${file ? "text-tertiary" : "text-primary"}`}
                  />
                </div>
                <h3 className="mb-2 font-headline-md text-headline-md text-on-surface">
                  {file ? "Clip selected" : "Select Game Film"}
                </h3>
                <p className="mb-4 font-body-md text-on-surface-variant">
                  {file ? "Tap to choose a different clip" : "Drag and drop your MP4 or MOV clip here"}
                </p>
                <div className="flex flex-wrap justify-center gap-3">
                  <span className="rounded border border-white/5 bg-surface-container-highest px-3 py-1 font-label-sm text-label-sm uppercase">
                    MP4
                  </span>
                  <span className="rounded border border-white/5 bg-surface-container-highest px-3 py-1 font-label-sm text-label-sm uppercase">
                    MOV
                  </span>
                  <span className="rounded border border-white/5 bg-surface-container-highest px-3 py-1 font-label-sm text-label-sm uppercase">
                    Max {uploadRules.maxLabel}
                  </span>
                </div>
              </div>
            </div>

            {/* Error state — unsupported / oversized / empty */}
            {error && (
              <div className="flex items-start gap-3 rounded-xl border border-error/30 bg-error/10 p-4" role="alert" aria-live="assertive">
                <Icon name="error" className="mt-0.5 shrink-0 text-error" fill />
                <div>
                  <p className="font-body-md font-bold text-error">That clip won't work</p>
                  <p className="font-body-md text-on-surface-variant">{error}</p>
                </div>
              </div>
            )}

            {/* File-selected state with remove option */}
            {file && (
              <GlassPanel className="flex items-center justify-between gap-4 p-4">
                <div className="flex min-w-0 items-center gap-3">
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-tertiary/10">
                    <Icon name="movie" className="text-tertiary" />
                  </div>
                  <div className="min-w-0">
                    <p className="truncate font-body-md text-on-surface">{file.name}</p>
                    <p className="font-label-sm text-label-sm text-on-surface-variant">
                      {formatBytes(file.size)} · Ready to analyze
                    </p>
                  </div>
                </div>
                <button
                  onClick={removeFile}
                  className="flex shrink-0 items-center gap-1 rounded-lg px-3 py-2 font-label-sm text-label-sm uppercase tracking-wide text-on-surface-variant transition-colors hover:bg-error/10 hover:text-error active:scale-95"
                  aria-label={`Remove ${file.name}`}
                >
                  <Icon name="close" className="text-[18px]" />
                  Remove
                </button>
              </GlassPanel>
            )}

            <GlassPanel className="flex flex-col gap-4 p-6">
              <div className="flex items-center justify-between">
                <span className="font-label-md text-label-md uppercase tracking-widest text-on-surface-variant">
                  Storage Status
                </span>
                <span className="font-label-md text-label-md text-primary">72% Full</span>
              </div>
              <div className="h-1 w-full overflow-hidden rounded-full bg-surface-variant">
                <div className="h-full w-[72%] bg-primary-container" />
              </div>
            </GlassPanel>
          </div>

          {/* Checklist + CTA */}
          <div className="flex flex-col gap-6 lg:col-span-4">
            <GlassPanel className="overflow-hidden">
              <div className="border-b border-white/10 bg-primary/10 p-4">
                <h4 className="flex items-center gap-2 font-label-md text-label-md font-bold uppercase tracking-widest text-primary">
                  <Icon name="bolt" className="text-sm" fill />
                  Analysis Checklist
                </h4>
              </div>
              <div className="space-y-5 p-6">
                {checklist.map((item) => (
                  <div key={item.title} className="flex items-start gap-4">
                    <div className="mt-0.5 flex h-6 w-6 items-center justify-center rounded border border-tertiary/50 bg-tertiary/10">
                      <Icon name="check" className="text-sm text-tertiary" />
                    </div>
                    <div>
                      <p className="font-body-md font-bold text-on-surface">{item.title}</p>
                      <p className="font-label-sm text-label-sm text-on-surface-variant">{item.detail}</p>
                    </div>
                  </div>
                ))}
              </div>
            </GlassPanel>

            <Button
              className="h-16 w-full"
              icon={uploading ? "cloud_upload" : "psychology"}
              disabled={!file || uploading}
              onClick={startAnalysis}
            >
              {uploading ? `Uploading… ${progress}%` : "Get My Chel Rating"}
            </Button>

            {uploading && (
              <div
                className="h-1.5 w-full overflow-hidden rounded-full bg-surface-variant"
                role="progressbar"
                aria-valuenow={progress}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-label="Upload progress"
              >
                <div
                  className="h-full rounded-full bg-primary-container transition-all duration-200"
                  style={{ width: `${progress}%` }}
                />
              </div>
            )}

            <p className="text-center font-label-sm text-label-sm text-on-surface-variant">
              {file
                ? "Free · No sign-up · Your clip is analyzed, never shared."
                : "Select an MP4 or MOV clip to start your analysis."}
            </p>

            <GlassPanel className="relative overflow-hidden bg-surface-container-high/50 p-6">
              <div className="absolute left-0 top-0 h-full w-1 bg-secondary" />
              <p className="mb-1 font-label-md text-label-md font-bold uppercase tracking-tighter text-secondary">
                Pro Tip
              </p>
              <p className="font-body-md text-on-surface-variant">
                Upload 1080p+ footage at 60fps for the most accurate gap-control measurements and stick-handling grades.
              </p>
            </GlassPanel>
          </div>
        </div>
      </main>

      <BottomNav active="film" />
    </div>
  );
}
