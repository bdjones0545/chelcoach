# ChelCoach — FFmpeg Frame Extraction (Phase 3)

Bounded, in-process video inspection and frame extraction after clip commit.
Extracted frames are consumed by Phase 4 AI analysis **before** workspace cleanup
(see [`docs/ai-gameplay-analysis.md`](ai-gameplay-analysis.md)). Extraction success
alone does not mark the job completed.

## Prerequisites

The API needs system `ffmpeg` and `ffprobe` on `PATH` (or explicit overrides).

### macOS

```bash
brew install ffmpeg
ffmpeg -version
ffprobe -version
```

### Linux (Debian/Ubuntu)

```bash
sudo apt-get update && sudo apt-get install -y ffmpeg
ffmpeg -version
ffprobe -version
```

### Replit / deploy images

Install system ffmpeg in the environment image (the repo no longer pins ffmpeg via
`replit.nix`). On Debian-based images: `apt-get install -y ffmpeg`.

## Environment variables

All optional — defaults are conservative MVP values (see `server/src/media/config.ts`).

| Var | Default | Purpose |
|---|---|---|
| `FFMPEG_PATH` | (PATH) | Absolute path to ffmpeg if not on PATH |
| `FFPROBE_PATH` | (PATH) | Absolute path to ffprobe if not on PATH |
| `MEDIA_MAX_DURATION_SEC` | `180` | Reject longer clips |
| `MEDIA_MAX_FRAMES` | `12` | Cap extracted frames |
| `MEDIA_MAX_FRAME_WIDTH` | `1280` | Scale frames down |
| `MEDIA_MAX_PIXELS` | `2073600` (1080p) | Reject huge resolutions |
| `MEDIA_PROCESS_TIMEOUT_MS` | `60000` | Per ffprobe/ffmpeg call timeout |
| `MEDIA_MAX_PROCESS_OUTPUT_BYTES` | `65536` | Bound captured stdout/stderr |
| `MEDIA_MAX_CONCURRENT_JOBS` | `1` | In-process concurrency |
| `MEDIA_EDGE_SKIP_FRACTION` | `0.05` | Skip start/end when sampling |
| `MEDIA_JPEG_QUALITY` | `3` | ffmpeg `-q:v` for JPEG stills |

**Upload size** is capped at **250 MB** in the shared `uploadRules` (down from 2 GB)
because uploads are still fully buffered in Node RAM and extraction runs in-process.

## Local testing

```bash
cd shared && npm ci
cd ../server && npm ci
npm run typecheck
npm test                 # unit + integration (skips real ffmpeg tests if missing)
npm run smoke            # boots app; runs real extraction when ffmpeg is present
```

## Lifecycle

```
upload init → PUT bytes → commit (HTTP returns immediately, status=queued)
  → extracting / inspecting_video
  → extracting_frames
  → finalizing
  → complete + sample report   OR   failed + safe error code
```

Demo commits (`static-demo-clip`) still complete immediately without FFmpeg.

## In-process job limitations

- Jobs die if the API process restarts.
- Not safe across multiple API instances (no distributed lock).
- Shares CPU/RAM with HTTP on the same VM.
- Temporary frames are deleted after each job; only metadata is retained on the clip record.

A later worker/queue can replace `server/src/jobs/extractionQueue.ts` without changing
the public status contract.

## Phase boundary

| This phase | Next (AI) |
|---|---|
| ffprobe + bounded JPEG frames | Claude vision / structured AnalysisReport |
| Sample report after success | Model-produced report validated by Zod |
| No coaching-moment detection | Moments mapped to nearest frame timestamps |
