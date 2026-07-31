import { defineConfig } from "vitest/config";

/**
 * Separate from vite.config.ts so `tsc -b` (tsconfig.node) is not coupled to
 * Vitest's bundled Vite types — Vite 8 vs Vitest's Vite peer can disagree.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
