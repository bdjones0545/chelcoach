/**
 * Local simulator phase durations only — not production estimates.
 */
export interface SimulatorTimings {
  queuedMs: number;
  inspectingMs: number;
  extractingMs: number;
  identifyingMs: number;
  analyzingMs: number;
  validatingMs: number;
  finalizingMs: number;
  /** Full-game multiplier for analyzing phase. */
  fullGameAnalyzingMultiplier: number;
  maxJobAgeMs: number;
  pollActiveMs: number;
}

function intEnvFrom(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min || n > max) {
    throw new Error(`[chelcoach-simulator] Invalid ${name}=${raw}`);
  }
  return Math.floor(n);
}

export function loadSimulatorTimings(env: NodeJS.ProcessEnv = process.env): SimulatorTimings {
  return {
    queuedMs: intEnvFrom(env, "SCOTTY_SIMULATOR_QUEUED_MS", 1000, 0, 60_000),
    inspectingMs: intEnvFrom(env, "SCOTTY_SIMULATOR_INSPECTING_MS", 1500, 0, 60_000),
    extractingMs: intEnvFrom(env, "SCOTTY_SIMULATOR_EXTRACTING_MS", 2000, 0, 60_000),
    identifyingMs: intEnvFrom(env, "SCOTTY_SIMULATOR_IDENTIFYING_MS", 1500, 0, 60_000),
    analyzingMs: intEnvFrom(env, "SCOTTY_SIMULATOR_ANALYZING_MS", 4000, 0, 120_000),
    validatingMs: intEnvFrom(env, "SCOTTY_SIMULATOR_VALIDATING_MS", 1500, 0, 60_000),
    finalizingMs: intEnvFrom(env, "SCOTTY_SIMULATOR_FINALIZING_MS", 1000, 0, 60_000),
    fullGameAnalyzingMultiplier: 2,
    maxJobAgeMs: intEnvFrom(env, "SCOTTY_SIMULATOR_MAX_JOB_AGE_MS", 120_000, 5_000, 3_600_000),
    pollActiveMs: intEnvFrom(env, "SCOTTY_SIMULATOR_POLL_MS", 1000, 200, 10_000),
  };
}

/** Fast timings for unit tests (still elapsed-time based with FakeClock). */
export const TEST_SIMULATOR_TIMINGS: SimulatorTimings = {
  queuedMs: 100,
  inspectingMs: 100,
  extractingMs: 100,
  identifyingMs: 100,
  analyzingMs: 200,
  validatingMs: 100,
  finalizingMs: 100,
  fullGameAnalyzingMultiplier: 2,
  maxJobAgeMs: 500_000,
  pollActiveMs: 500,
};
