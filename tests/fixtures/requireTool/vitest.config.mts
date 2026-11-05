/** Minimal vitest config for requireToolRun.test.ts: the teardown globalSetup and one suite that skips through requireTool, nothing else. */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { root: __dirname, include: ['skips.fixture.ts'], globalSetup: ['../../requireToolTeardown.ts'], maxWorkers: 1, watch: false },
});
