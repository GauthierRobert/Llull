/**
 * Vitest config for the quality gates (server/tests/quality/*.gate.ts). Separate from
 * vitest.config.mts: they take minutes. The STEP gate needs the downloaded corpus + CadQuery
 * (npm run quality:fetch && npm run quality:step); the drawing gate needs only the OCC wasm
 * (npm run quality:drawings).
 */
import { defineConfig } from 'vitest/config';
import base from './vitest.config.mts';

export default defineConfig({
  ...base,
  test: {
    ...base.test,
    include: ['tests/quality/**/*.gate.ts'],
    // the render reference gate has its own config and npm script (vitest.render.config.mts, npm run render:reference)
    exclude: ['tests/quality/renderReference.gate.ts'],
    testTimeout: 600_000,
    hookTimeout: 600_000,
  },
});
