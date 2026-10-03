import { defineConfig, configDefaults } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

export default defineConfig(({ command }) => ({
  plugins: [react()],
  // Serve .wasm files with the correct MIME type so WebAssembly.instantiateStreaming
  // succeeds in the browser (manifold-3d, opencascade.js). Vite dev-server otherwise
  // serves them as application/octet-stream which browsers reject for streaming compile.
  assetsInclude: ['**/*.wasm'],
  build: {
    chunkSizeWarningLimit: 900, // three.js alone is ~800 kB and cannot be split further
    rollupOptions: {
      output: {
        manualChunks(id: string): string | undefined {
          if (!id.includes('node_modules')) return undefined;
          if (id.includes('/three/') || id.includes('three-stdlib') || id.includes('three-mesh-bvh'))
            return 'vendor-three';
          if (id.includes('@react-three') || id.includes('/postprocessing/')) return 'vendor-r3f';
          if (id.includes('/react/') || id.includes('/react-dom/') || id.includes('/scheduler/'))
            return 'vendor-react';
          return undefined;
        },
      },
    },
  },
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
      // manifold-3d's Node-only branch imports node:module; stub it for browser bundles only
      // (the vitest/node run keeps the real module).
      ...(command === 'build'
        ? { 'node:module': resolve(__dirname, 'src/ui/geometry/nodeModuleStub.ts') }
        : {}),
      '@core': resolve(__dirname, 'packages/core/src'),
      '@lib': resolve(__dirname, 'packages/core/src/lib'),
      '@mcp': resolve(__dirname, 'packages/mcp/src'),
      '@aec': resolve(__dirname, 'packages/domain-aec/src'),
      '@kernel-manifold': resolve(__dirname, 'packages/kernel-manifold/src'),
      '@kernel-occt': resolve(__dirname, 'packages/kernel-occt/src'),
      '@ui': resolve(__dirname, 'src/ui'),
      '@app': resolve(__dirname, 'src/app'),
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
    exclude: [...configDefaults.exclude, '.claude/worktrees/**', 'server/**', 'tests/e2e/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      // The command layer is the heart of the app — hold it to a high bar.
      include: ['packages/*/src/**'],
      // Type-only modules compile to nothing at runtime, so v8 reports them as 0%
      // (they are never loaded — `import type` is erased). Exclude them so the gate
      // measures real command logic, not declaration files.
      exclude: ['packages/*/src/**/types.ts', 'packages/*/src/**/*.d.ts'],
      thresholds: {
        'packages/core/src/commands/**': { statements: 90, branches: 85, functions: 90, lines: 90 },
        'packages/domain-aec/src/**': { statements: 90, branches: 85, functions: 90, lines: 90 },
      },
    },
  },
}));
