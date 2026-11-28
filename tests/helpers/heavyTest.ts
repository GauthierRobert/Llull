/**
 * Timeout of a test whose own work takes 13–25 s on a quiet machine (deform flows, subdivision fits, TPMS fractions): the default
 * 30 s (`vite.config.ts` testTimeout) leaves no margin under v8 coverage instrumentation, where these run about 1.5–2x slower, so
 * `npm run check:coverage` timed them out although their assertions pass.
 */
export const HEAVY_TEST_TIMEOUT_MS = 120_000;
