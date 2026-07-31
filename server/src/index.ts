import app from "./vercelApp";

// Local / long-running process only — never listen inside Vercel Functions.
if (!process.env.VERCEL) {
  const port = Number(process.env.PORT) || 3001;
  app.listen(port, () => {
    console.log(`[chelcoach-api] listening on http://localhost:${port}`);
  });
}

export default app;
