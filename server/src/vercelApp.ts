/**
 * Export the Express app for serverless adapters (Vercel).
 * Never call listen() from this module.
 */
import { createApp } from "./app";

// Single app instance reused across warm invocations.
const app = createApp();

export default app;
