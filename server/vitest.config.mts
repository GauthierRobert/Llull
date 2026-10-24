/**
 * Vitest config for server-side tests.
 *
 * Uses the Node environment (no jsdom — the server has no DOM).
 * Path aliases come from tsconfig.base.json (workspaceAliases), like every other config.
 */
import { defineConfig } from 'vitest/config';
import { workspaceAliases } from '../workspaceAliases.ts';
import { testWorkers } from '../testWorkers.ts';

export default defineConfig({
  resolve: { alias: workspaceAliases() },
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    setupFiles: ['./tests/setup.ts'],
    // Live OpenCascade / Manifold solves (booleans, fillets, STEP) take seconds each.
    testTimeout: 30_000,
    maxWorkers: testWorkers(),
    // Tests that drive tools/list or tools/call across every toolset need them all exposed.
    env: { LLULL_TOOLSETS: 'all' },
  },
});
