import { useEffect, useRef, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import BottomNav from "../components/BottomNav";
import Button from "../components/Button";
import GlassPanel from "../components/GlassPanel";
import Icon from "../components/Icon";
import TopAppBar from "../components/TopAppBar";
import {
  GAME_CATALOG,
  RELEASED_NOT_SUPPORTED_MESSAGE,
  isGameAcceptableForUpload,
  type GameCatalogEntry,
} from "../data/gameCatalog";
import { uploadErrors, uploadRules } from "../data/mockData";
import { USE_BACKEND_REPORTS } from "../lib/reportApi";
import { storeReadyUploadId } from "../lib/playerIdentificationApi";
import {
  cancelUpload,
  createUploadSession,
  ensureOwnerSession,
  fetchGameplayProfile,
  uploadDirect,
} from "../lib/scottyUploadApi";
type UploadUiState =
  | "idle"
  | "preparing"
  | "uploading"
  | "verifying"
  | "inspecting"
  | "ready"
  | "failed"
  | "cancelled";

const PLATFORMS = [
  { value: "xbox_series", label: "Xbox Series X|S" },
  { value: "xbox_one", label: "Xbox One" },
  { value: "playstation_5", label: "PlayStation 5" },
  { value: "playstation_4", label: "PlayStation 4" },
] as const;

const CONTROL_SCHEMES = [
  { value: "skill_stick", label: "Skill Stick" },
  { value: "total_control", label: "Total Control" },
  { value: "hybrid", label: "Hybrid" },
  { value: "goalie", label: "Goalie" },
] as const;

const POSITIONS = [
  { value: "C", label: "Center" },
  { value: "LW", label: "Left Wing" },
  { value: "RW", label: "Right Wing" },
  { value: "LD", label: "Left Defense" },
  { value: "RD", label: "Right Defense" },
  { value: "G", label: "Goalie" },
] as const;

const GAME_MODES = [
  { value: "eashl", label: "EASHL" },
  { value: "world_of_chel", label: "World of Chel" },
  { value: "online_versus", label: "Online Versus" },
  { value: "hut", label: "HUT" },
  { value: "offline", label: "Offline" },
  { value: "practice", label: "Practice" },
] as const;

const TEAM_SIDES = [
  { value: "", label: "Not sure" },
  { value: "home", label: "Home" },
  { value: "away", label: "Away" },
] as const;

/** Default retention hours shown until the session response returns the configured value. */
const DEFAULT_RETENTION_HOURS = 24;

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

function mimeForFile(file: File): "video/mp4" | "video/quicktime" {
  if (file.type === "video/quicktime" || file.name.toLowerCase().endsWith(".mov")) {
    return "video/quicktime";
  }
  return "video/mp4";
}

function statusLabel(state: UploadUiState): string {
  switch (state) {
    case "preparing":
      return "Preparing upload…";
    case "uploading":
      return "Uploading…";
    case "verifying":
      return "Verifying upload…";
    case "inspecting":
      return "Inspecting video…";
    case "ready":
      return "Ready";
    case "failed":
      return "Failed";
    case "cancelled":
      return "Cancelled";
    default:
      return "";
  }
}

function FieldLabel({ htmlFor, children }: { htmlFor?: string; children: ReactNode }) {
  return (
    <label
      htmlFor={htmlFor}
      className="mb-1.5 block font-label-sm text-label-sm uppercase tracking-widest text-on-surface-variant"
    >
      {children}
    </label>
  );
}

function SelectField(props: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: readonly { value: string; label: string }[];
  required?: boolean;
}) {
  const selectId = `upload-field-${props.label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
  return (
    <div>
      <FieldLabel htmlFor={selectId}>
        {props.label}
        {props.required ? " *" : ""}
      </FieldLabel>
      <select
        id={selectId}
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
        aria-label={props.label}
        className="w-full rounded-lg border border-white/10 bg-surface-container-highest px-3 py-2.5 font-body-md text-on-surface outline-none focus:border-primary"
      >
        {props.options.map((o) => (
          <option key={o.value || "empty"} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}

export default function Upload() {
  const navigate = useNavigate();
  const inputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const [uiState, setUiState] = useState<UploadUiState>("idle");
  const [progress, setProgress] = useState(0);
  const [retentionNotice, setRetentionNotice] = useState(
    `Uploaded gameplay video is automatically deleted after ${DEFAULT_RETENTION_HOURS} hours. Your completed coaching report can remain available.`,
  );
  const [trustedDuration, setTrustedDuration] = useState<number | null>(null);
  const [mediaClass, setMediaClass] = useState<string | null>(null);
  const [activeUploadId, setActiveUploadId] = useState<string | null>(null);
  const [ownerToken, setOwnerToken] = useState<string | null>(null);

  // Gameplay context — prefilled from profile when available.
  const [gameId, setGameId] = useState("nhl-25");
  const [platform, setPlatform] = useState("xbox_series");
  const [controlScheme, setControlScheme] = useState("skill_stick");
  const [position, setPosition] = useState("C");
  const [gameMode, setGameMode] = useState("eashl");
  const [singlePlayer, setSinglePlayer] = useState(true);
  const [jerseyNumber, setJerseyNumber] = useState("");
  const [indicatorColor, setIndicatorColor] = useState("");
  const [teamSide, setTeamSide] = useState("");
  const [consoleGeneration, setConsoleGeneration] = useState("");
  const [saveAsDefaults, setSaveAsDefaults] = useState(false);
  const [profileLoaded, setProfileLoaded] = useState(false);

  const selectedGame: GameCatalogEntry | undefined = GAME_CATALOG.find((g) => g.canonicalGameId === gameId);
  const gameOk = selectedGame ? isGameAcceptableForUpload(selectedGame.supportStatus) : false;
  const busy = uiState === "preparing" || uiState === "uploading" || uiState === "verifying" || uiState === "inspecting";

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const token = await ensureOwnerSession();
        if (cancelled) return;
        setOwnerToken(token);
        const profile = await fetchGameplayProfile(token);
        if (cancelled) return;
        if (profile.preferredPlatform && profile.preferredPlatform !== "unknown") {
          setPlatform(profile.preferredPlatform);
        }
        if (profile.preferredControlScheme && profile.preferredControlScheme !== "unknown") {
          setControlScheme(profile.preferredControlScheme);
        }
        if (profile.primaryPosition && profile.primaryPosition !== "unknown") {
          setPosition(profile.primaryPosition);
        }
        if (profile.commonGameMode && profile.commonGameMode !== "unknown") {
          setGameMode(profile.commonGameMode);
        }
        if (profile.defaultIndicatorColor) setIndicatorColor(profile.defaultIndicatorColor);
        if (profile.defaultTeamSide) setTeamSide(profile.defaultTeamSide);
        if (profile.consoleGeneration) setConsoleGeneration(profile.consoleGeneration);
        if (profile.lastSelectedGameId) setGameId(profile.lastSelectedGameId);
        setProfileLoaded(true);
      } catch {
        // Offline / mock — form still usable with local defaults.
        setProfileLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

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
    setTrustedDuration(null);
    setMediaClass(null);
    setUiState("idle");
  };

  const removeFile = () => {
    setFile(null);
    setError(null);
    setTrustedDuration(null);
    setMediaClass(null);
    if (inputRef.current) inputRef.current.value = "";
  };

  const cancelActiveUpload = async () => {
    abortRef.current?.abort();
    abortRef.current = null;
    if (ownerToken && activeUploadId) {
      await cancelUpload(ownerToken, activeUploadId).catch(() => undefined);
    }
    setActiveUploadId(null);
    setUiState("cancelled");
    setProgress(0);
  };

  const startUpload = async () => {
    if (!file || !selectedGame || !gameOk || !singlePlayer) return;

    if (!USE_BACKEND_REPORTS) {
      // Mock conversion loop — context collected for UX, analysis still demo.
      navigate("/processing");
      return;
    }

    setError(null);
    setUiState("preparing");
    setProgress(0);
    setTrustedDuration(null);
    setMediaClass(null);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const token = ownerToken ?? (await ensureOwnerSession());
      setOwnerToken(token);

      const jersey = jerseyNumber.trim() === "" ? undefined : Number(jerseyNumber);
      if (jerseyNumber.trim() !== "" && (!Number.isInteger(jersey) || jersey! < 0 || jersey! > 99)) {
        setError("Jersey number must be between 0 and 99.");
        setUiState("failed");
        return;
      }

      const session = await createUploadSession(token, {
        filename: file.name,
        contentType: mimeForFile(file),
        sizeBytes: file.size,
        saveAsDefaults,
        context: {
          gameContext: {
            selectedGameTitle: selectedGame.title,
            canonicalGameId: selectedGame.canonicalGameId,
            supportStatus: selectedGame.supportStatus,
            mismatchState: "none",
          },
          playerContext: {
            platform,
            controlScheme,
            position,
            gameMode,
            ...(jersey !== undefined ? { jerseyNumber: jersey } : {}),
            ...(indicatorColor.trim() ? { indicatorColor: indicatorColor.trim() } : {}),
            ...(teamSide ? { teamSide } : {}),
            ...(consoleGeneration.trim() ? { consoleGeneration: consoleGeneration.trim() } : {}),
          },
          singlePlayerControl: true,
        },
      });

      setActiveUploadId(session.uploadId);
      setRetentionNotice(session.retentionNotice);
      setUiState("uploading");

      const detail = await uploadDirect(
        token,
        session,
        file,
        ({ percent }) => {
          setProgress(percent);
          if (percent >= 100) setUiState("verifying");
        },
        controller.signal,
      );

      if (detail.uploadStatus === "ready") {
        setUiState("ready");
        setTrustedDuration(detail.durationSec ?? null);
        setMediaClass(detail.mediaClassification ?? null);
        setRetentionNotice(detail.retentionNotice);
        storeReadyUploadId(session.uploadId);
        // Step 3: identify / confirm controlled player before demo processing loop.
        navigate(`/player-confirmation?uploadId=${encodeURIComponent(session.uploadId)}`);
        return;
      }

      if (detail.uploadStatus === "processing" || detail.uploadStatus === "uploaded") {
        setUiState("inspecting");
      }
      setUiState("ready");
      storeReadyUploadId(session.uploadId);
      navigate(`/player-confirmation?uploadId=${encodeURIComponent(session.uploadId)}`);
    } catch (err) {
      if (controller.signal.aborted || (err instanceof Error && err.message === "Upload cancelled")) {
        setUiState("cancelled");
        return;
      }
      setUiState("failed");
      setError(err instanceof Error ? err.message : "Upload failed. Check your connection and try again.");
    } finally {
      abortRef.current = null;
    }
  };

  const canSubmit =
    Boolean(file) &&
    gameOk &&
    singlePlayer &&
    Boolean(platform) &&
    Boolean(controlScheme) &&
    Boolean(position) &&
    Boolean(gameMode) &&
    !busy;

  return (
    <div className="min-h-screen bg-background pb-32">
      <TopAppBar />

      <main className="mx-auto max-w-container-max px-4 pt-24 md:px-gutter">
        <div className="mb-10 text-center md:text-left">
          <h1 className="mb-2 font-headline-xl text-[32px] uppercase text-on-surface md:text-headline-xl">
            Upload Gameplay
          </h1>
          <p className="max-w-2xl font-body-lg text-body-lg text-on-surface-variant">
            Drop in a short clip or a full game (up to 30 minutes). Confirm your gameplay settings so coaching stays
            accurate for the player you control.
          </p>
        </div>

        <div className="grid grid-cols-1 gap-gutter lg:grid-cols-12">
          <div className="flex flex-col gap-6 lg:col-span-8">
            <div
              role="button"
              tabIndex={0}
              aria-label="Upload a game clip. Accepts MP4 or MOV files up to 2 gigabytes."
              onClick={() => !busy && inputRef.current?.click()}
              onKeyDown={(e) => {
                if (busy) return;
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
                if (!busy) handleFiles(e.dataTransfer.files);
              }}
              className={`upload-dashed glass-panel group relative flex aspect-video w-full cursor-pointer flex-col items-center justify-center rounded-xl transition-all duration-300 hover:bg-primary/5 ${
                dragActive ? "is-active bg-primary/10" : ""
              } ${busy ? "pointer-events-none opacity-70" : ""}`}
            >
              <input
                ref={inputRef}
                type="file"
                accept={uploadRules.accept}
                aria-label="Choose a game clip to upload"
                className="hidden"
                disabled={busy}
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

            {error && (
              <div
                className="flex items-start gap-3 rounded-xl border border-error/30 bg-error/10 p-4"
                role="alert"
                aria-live="assertive"
              >
                <Icon name="error" className="mt-0.5 shrink-0 text-error" fill />
                <div>
                  <p className="font-body-md font-bold text-error">That clip won&apos;t work</p>
                  <p className="font-body-md text-on-surface-variant">{error}</p>
                </div>
              </div>
            )}

            {file && (
              <GlassPanel className="flex items-center justify-between gap-4 p-4">
                <div className="flex min-w-0 items-center gap-3">
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-tertiary/10">
                    <Icon name="movie" className="text-tertiary" />
                  </div>
                  <div className="min-w-0">
                    <p className="truncate font-body-md text-on-surface">{file.name}</p>
                    <p className="font-label-sm text-label-sm text-on-surface-variant">
                      {formatBytes(file.size)}
                      {trustedDuration != null ? ` · ${Math.round(trustedDuration)}s trusted` : ""}
                      {mediaClass ? ` · ${mediaClass.replace(/_/g, " ")}` : ""}
                    </p>
                  </div>
                </div>
                {!busy && (
                  <button
                    onClick={removeFile}
                    className="flex shrink-0 items-center gap-1 rounded-lg px-3 py-2 font-label-sm text-label-sm uppercase tracking-wide text-on-surface-variant transition-colors hover:bg-error/10 hover:text-error active:scale-95"
                    aria-label={`Remove ${file.name}`}
                  >
                    <Icon name="close" className="text-[18px]" />
                    Remove
                  </button>
                )}
              </GlassPanel>
            )}

            <GlassPanel className="p-6">
              <div className="mb-4 flex items-center justify-between gap-3">
                <h2 className="font-headline-md text-headline-md text-on-surface">Gameplay settings</h2>
                {profileLoaded && (
                  <span className="font-label-sm text-label-sm text-on-surface-variant">
                    Prefills apply to this upload
                  </span>
                )}
              </div>
              <p className="mb-6 font-body-md text-on-surface-variant">
                Changes apply to this upload only unless you save them as defaults.
              </p>

              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <SelectField
                  label="NHL title"
                  required
                  value={gameId}
                  onChange={setGameId}
                  options={GAME_CATALOG.map((g) => ({ value: g.canonicalGameId, label: g.title }))}
                />
                <SelectField
                  label="Platform"
                  required
                  value={platform}
                  onChange={setPlatform}
                  options={[...PLATFORMS]}
                />
                <SelectField
                  label="Control scheme"
                  required
                  value={controlScheme}
                  onChange={setControlScheme}
                  options={[...CONTROL_SCHEMES]}
                />
                <SelectField
                  label="Position"
                  required
                  value={position}
                  onChange={setPosition}
                  options={[...POSITIONS]}
                />
                <SelectField
                  label="Game mode"
                  required
                  value={gameMode}
                  onChange={setGameMode}
                  options={[...GAME_MODES]}
                />
                <SelectField
                  label="Team side"
                  value={teamSide}
                  onChange={setTeamSide}
                  options={[...TEAM_SIDES]}
                />
                <div>
                  <FieldLabel>Jersey number</FieldLabel>
                  <input
                    type="number"
                    min={0}
                    max={99}
                    inputMode="numeric"
                    value={jerseyNumber}
                    onChange={(e) => setJerseyNumber(e.target.value)}
                    placeholder="Optional"
                    className="w-full rounded-lg border border-white/10 bg-surface-container-highest px-3 py-2.5 font-body-md text-on-surface outline-none focus:border-primary"
                  />
                </div>
                <div>
                  <FieldLabel>Player indicator color</FieldLabel>
                  <input
                    type="text"
                    value={indicatorColor}
                    onChange={(e) => setIndicatorColor(e.target.value)}
                    placeholder="Optional (e.g. blue)"
                    className="w-full rounded-lg border border-white/10 bg-surface-container-highest px-3 py-2.5 font-body-md text-on-surface outline-none focus:border-primary"
                  />
                </div>
                <div className="sm:col-span-2">
                  <FieldLabel>Console generation</FieldLabel>
                  <input
                    type="text"
                    value={consoleGeneration}
                    onChange={(e) => setConsoleGeneration(e.target.value)}
                    placeholder="Optional"
                    className="w-full rounded-lg border border-white/10 bg-surface-container-highest px-3 py-2.5 font-body-md text-on-surface outline-none focus:border-primary"
                  />
                </div>
              </div>

              {selectedGame?.supportStatus === "released_not_yet_supported" && (
                <div className="mt-4 rounded-lg border border-secondary/30 bg-secondary/10 p-3 font-body-md text-on-surface">
                  {RELEASED_NOT_SUPPORTED_MESSAGE}
                </div>
              )}
              {selectedGame && !gameOk && selectedGame.supportStatus !== "released_not_yet_supported" && (
                <div className="mt-4 rounded-lg border border-error/30 bg-error/10 p-3 font-body-md text-error">
                  This title is not supported for analysis yet.
                </div>
              )}

              <label className="mt-6 flex cursor-pointer items-start gap-3">
                <input
                  type="checkbox"
                  checked={singlePlayer}
                  onChange={(e) => setSinglePlayer(e.target.checked)}
                  className="mt-1"
                />
                <span className="font-body-md text-on-surface">
                  I control one player in this clip *
                </span>
              </label>

              <label className="mt-4 flex cursor-pointer items-start gap-3">
                <input
                  type="checkbox"
                  checked={saveAsDefaults}
                  onChange={(e) => setSaveAsDefaults(e.target.checked)}
                  className="mt-1"
                />
                <span className="font-body-md text-on-surface">Save these settings as my defaults</span>
              </label>
            </GlassPanel>
          </div>

          <div className="flex flex-col gap-6 lg:col-span-4">
            <GlassPanel className="p-6">
              <h4 className="mb-3 font-label-md text-label-md font-bold uppercase tracking-widest text-primary">
                Upload status
              </h4>
              <p className="mb-2 font-body-md text-on-surface">
                {uiState === "idle" ? "Waiting for your clip" : statusLabel(uiState)}
              </p>
              {(uiState === "uploading" || uiState === "verifying") && (
                <div
                  className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-surface-variant"
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
              {busy && uiState === "uploading" && (
                <p className="mt-2 font-label-sm text-label-sm text-on-surface-variant">{progress}% transferred</p>
              )}
              {busy && (
                <Button className="mt-4 w-full" variant="ghost" onClick={cancelActiveUpload}>
                  Cancel upload
                </Button>
              )}
            </GlassPanel>

            <Button
              className="h-16 w-full"
              icon={busy ? "cloud_upload" : "psychology"}
              disabled={!canSubmit}
              onClick={startUpload}
            >
              {busy
                ? `${statusLabel(uiState)}${uiState === "uploading" ? ` ${progress}%` : ""}`
                : "Get My Chel Rating"}
            </Button>

            <p className="text-center font-label-sm text-label-sm text-on-surface-variant">
              {retentionNotice}
            </p>

            <GlassPanel className="relative overflow-hidden bg-surface-container-high/50 p-6">
              <div className="absolute left-0 top-0 h-full w-1 bg-secondary" />
              <p className="mb-1 font-label-md text-label-md font-bold uppercase tracking-tighter text-secondary">
                Privacy
              </p>
              <p className="font-body-md text-on-surface-variant">
                We only ask for gameplay context needed for coaching — not your real name, gamertag, or email.
              </p>
            </GlassPanel>
          </div>
        </div>
      </main>

      <BottomNav active="film" />
    </div>
  );
}
