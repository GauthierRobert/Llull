/** Vitest config of the fatigue benchmark only (`fatigueBenchmark.bench.ts`); the default `vitest run` never collects it. */
import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';
import { workspaceAliases } from '../../../workspaceAliases.ts';

const root = resolve(import.meta.dirname, '../../..');

export default defineConfig({
  resolve: { alias: workspaceAliases() },
  test: { root, environment: 'node', setupFiles: ['tests/setup.ts'], include: ['tests/unit/native/fatigueBenchmark.bench.ts'] },
});
