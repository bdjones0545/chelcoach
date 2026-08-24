/**
 * Vercel Functions entry (Step 10.1D) — Express control plane wrapper.
 * Does not call listen(). Does not run ffprobe or download gameplay media.
 */
import app from "../server/src/config/vercelApp.bundle.mjs";

export default app;
