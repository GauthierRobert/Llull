import { defineConfig, configDefaults } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

export default defineConfig({
  plugins: [react()],
  // Serve .wasm files with the correct MIME type so WebAssembly.instantiateStreaming
  // succeeds in the browser (manifold-3d, opencascade.js). Vite dev-server otherwise
  // serves them as application/octet-stream which browsers reject for streaming compile.
  assetsInclude: ['**/*.wasm'],
  server: {
    headers: {
      // Required for SharedArrayBuffer / COOP-COEP if needed; harmless otherwise.
      // application/wasm is set by Vite's built-in mime map when assetsInclude covers .wasm.
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  resolve: {
    alias: {
      '@core': resolve(__dirname, 'src/core'),
      '@ui': resolve(__dirname, 'src/ui'),
      '@lib': resolve(__dirname, 'src/lib'),
    },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: './tests/setup.ts',
    // Isolated agent worktrees (continue-working skill) live under the repo root
    // and contain full repo copies; never scan them for tests.
    // `server/**` has its own node-env vitest config — keep it out of the app
    // (jsdom) suite so the two never cross-contaminate.
    exclude: [...configDefaults.exclude, '.claude/worktrees/**', 'server/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      // The command layer is the heart of the app — hold it to a high bar.
      include: ['src/core/**'],
      // Type-only modules compile to nothing at runtime, so v8 reports them as 0%
      // (they are never loaded — `import type` is erased). Exclude them so the gate
      // measures real command logic, not declaration files.
      exclude: ['src/core/**/types.ts'],
      thresholds: {
        'src/core/commands/**': { statements: 90, branches: 85, functions: 90, lines: 90 },
      },
    },
  },
});
