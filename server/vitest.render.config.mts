/**
 * Vitest config for the render reference gate (RV1 §7 V3; server/tests/quality/renderReference.gate.ts, docs/QUALITY_GATES.md):
 *   npm run render:reference        compare llull with the pinned Cycles references
 *   npm run render:reference:bake   bake missing / stale references with Blender Cycles first
 * One worker: the path tracer and Blender use every core.
 */
import { defineConfig } from 'vitest/config';
import base from './vitest.config.mts';

export default defineConfig({
  ...base,
  test: {
    ...base.test,
    include: ['tests/quality/renderReference.gate.ts'],
    testTimeout: 7_200_000,
    hookTimeout: 600_000,
    maxWorkers: 1,
    fileParallelism: false,
    silent: false,
  },
});
