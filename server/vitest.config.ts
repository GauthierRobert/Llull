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
      '@core': resolve(__dirname, '../src/core'),
      '@lib': resolve(__dirname, '../src/lib'),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
