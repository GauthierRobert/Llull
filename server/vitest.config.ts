/**
 * Vitest config for server-side tests.
 *
 * Uses the Node environment (no jsdom — the server has no DOM).
 * Resolves the same path aliases as server/tsconfig.json so server tests can
 * import @core/* and @lib/* without relative ../../ gymnastics.
 */
import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      '@core': resolve(__dirname, '../packages/core/src'),
      '@lib': resolve(__dirname, '../packages/core/src/lib'),
      '@mcp': resolve(__dirname, '../packages/mcp/src'),
      '@aec': resolve(__dirname, '../packages/domain-aec/src'),
      '@kernel-manifold': resolve(__dirname, '../packages/kernel-manifold/src'),
      '@kernel-occt': resolve(__dirname, '../packages/kernel-occt/src'),
      '@app': resolve(__dirname, '../src/app'),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    setupFiles: ['./tests/setup.ts'],
    // Tests that drive tools/list or tools/call across every toolset need them all exposed.
    env: { LLULL_TOOLSETS: 'all' },
  },
});
