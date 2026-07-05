{ pkgs }: {
  deps = [
    pkgs.nodejs_22

    # Phase 3 (frame extraction) — DO NOT enable yet. Uncomment when ffmpeg-based
    # sampling is implemented in the backend worker.
    # pkgs.ffmpeg-full
  ];
}
