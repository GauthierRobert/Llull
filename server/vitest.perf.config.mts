/**
 * Vitest config for the performance gate (server/tests/perf/*.gate.ts; docs/decisions/PERF1-performance-budgets.md): `npm run perf`.
 * Separate from vitest.config.mts: one worker, no parallel files, so a measurement never shares the CPU with another suite.
 */
import { defineConfig } from 'vitest/config';
import base from './vitest.config.mts';

export default defineConfig({
  ...base,
  test: {
    ...base.test,
    include: ['tests/perf/**/*.gate.ts'],
    testTimeout: 600_000,
    hookTimeout: 600_000,
    maxWorkers: 1,
    // The table of measurements is the point of the run: show it for passing files too.
    silent: false,
    fileParallelism: false,
  },
});
