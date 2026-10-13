/**
 * Vitest config for the desktop app's Electron-free modules (backend lifecycle, documents,
 * navigation, CLI shim, menu). Node environment; path aliases come from tsconfig.base.json.
 */
import { defineConfig } from 'vitest/config';
import { workspaceAliases } from '../workspaceAliases.ts';

export default defineConfig({
  resolve: { alias: workspaceAliases() },
  test: { globals: true, environment: 'node', include: ['tests/**/*.test.ts'], testTimeout: 30_000 },
});
