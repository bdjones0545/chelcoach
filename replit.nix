{ pkgs }: {
  deps = [
    pkgs.nodejs_22

    # Phase 3 — frame extraction (ffprobe + ffmpeg).
    pkgs.ffmpeg-full
  ];
}
