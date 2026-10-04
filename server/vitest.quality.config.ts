/**
 * Vitest config for the import quality gates (server/tests/quality/*.gate.ts).
 * Separate from vitest.config.ts: needs the downloaded corpus + CadQuery, and takes minutes.
 *   npm run quality:fetch && npm run quality:step
 */
import { defineConfig } from 'vitest/config';
import base from './vitest.config';

export default defineConfig({
  ...base,
  test: {
    ...base.test,
    include: ['tests/quality/**/*.gate.ts'],
    testTimeout: 600_000,
    hookTimeout: 600_000,
  },
});
