import { createApp } from "./app";
import { mediaBinariesAvailable } from "./media/binaries";
import { shutdownExtractionQueue } from "./jobs/extractionQueue";

const port = Number(process.env.PORT) || 3001;
const app = createApp();

const server = app.listen(port, () => {
  const media = mediaBinariesAvailable() ? "ffmpeg ready" : "ffmpeg MISSING — extraction will fail";
  console.log(`[chelcoach-api] listening on http://localhost:${port} (phase 3 extraction; ${media})`);
});

function shutdown(signal: string) {
  console.log(`[chelcoach-api] ${signal} — shutting down extraction queue`);
  shutdownExtractionQueue();
  server.close(() => process.exit(0));
  // Force-exit if HTTP drain hangs.
  setTimeout(() => process.exit(0), 5_000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
