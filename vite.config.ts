import { defineConfig, configDefaults } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
import { workspaceAliases } from './workspaceAliases.ts';
import { ISOLATED_SUITES } from './tests/isolatedSuites.ts';

const testExcludes = [...configDefaults.exclude, '.claude/worktrees/**', 'server/**', 'desktop/**', 'tests/e2e/**'];
const NODE_SUITES = ['tests/unit/**/*.test.ts', 'tests/golden/**/*.test.ts'];
const DOM_SUITES = [
  'tests/component/**/*.test.{ts,tsx}',
  'tests/integration/**/*.test.{ts,tsx}',
  'tests/production/**/*.test.ts',
  'tests/unit/**/*.test.tsx',
];

export default defineConfig(({ command }) => ({
  plugins: [react()],
  // Serve .wasm files with the correct MIME type so WebAssembly.instantiateStreaming
  // succeeds in the browser (manifold-3d). Vite dev-server otherwise
  // serves them as application/octet-stream which browsers reject for streaming compile.
  assetsInclude: ['**/*.wasm'],
  // Pre-bundling moves manifold-3d into node_modules/.vite/deps/, where emscripten's sibling
  // `manifold.wasm` lookup 404s into the SPA fallback (index.html): the kernel never initialises.
  optimizeDeps: { exclude: ['manifold-3d', '@mujoco/mujoco'] },
  build: {
    chunkSizeWarningLimit: 900, // three.js alone is ~800 kB and cannot be split further
    rolldownOptions: {
      output: {
        // Higher priority wins a shared module, so the leaf libraries (three, react) claim
        // theirs before vendor-r3f pulls its dependencies in recursively.
        codeSplitting: {
          groups: [
            { name: 'vendor-react', test: /node_modules[\\/](react|react-dom|scheduler)[\\/]/, priority: 2 },
            { name: 'vendor-r3f', test: /node_modules[\\/](@react-three|postprocessing)[\\/]/, priority: 1 },
            { name: 'vendor-three', test: /node_modules[\\/](three|three-stdlib|three-mesh-bvh)[\\/]/, priority: 3 },
            // The registry needs every plugin at startup, so these load eagerly; separate chunks keep each under the warning limit.
            { name: 'llull-core', test: /packages[\\/]core[\\/]src[\\/]/, priority: 1 },
            { name: 'llull-cae', test: /packages[\\/]domain-cae[\\/]src[\\/]/, priority: 1 },
            { name: 'llull-aero', test: /packages[\\/]domain-aero[\\/]src[\\/]/, priority: 1 },
            { name: 'llull-aec', test: /packages[\\/]domain-aec[\\/]src[\\/]/, priority: 1 },
          ],
        },
      },
    },
  },
  resolve: {
    alias: {
      // manifold-3d's Node-only branch imports node:module; stub it for the renderer bundle only
      // (the vitest/node run keeps the real module).
      ...(command === 'build' ? { 'node:module': resolve(import.meta.dirname, 'src/ui/geometry/nodeModuleStub.ts') } : {}),
      ...workspaceAliases(),
    },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: './tests/setup.ts',
    // Domain suites run whole engineering solves (portal-frame design, golden plans) that take
    // several seconds, more under coverage instrumentation.
    testTimeout: 30_000,
    // Isolated agent worktrees (continue-working skill) live under the repo root
    // and contain full repo copies; never scan them for tests.
    // `server/**` has its own node-env vitest config — keep it out of the app
    // (jsdom) suite so the two never cross-contaminate.
    exclude: testExcludes,
    // `node`: pure command/plugin suites share one module graph per worker (no jsdom, no per-file re-import of
    // every plugin); tests/setup.ts resets the injected process singletons per file. Files that mock modules,
    // stub globals, use the DOM or grow the registry keep a fresh jsdom module graph (`isolated`, `dom`).
    projects: [
      {
        extends: true,
        test: { name: 'node', environment: 'node', isolate: false, include: NODE_SUITES, exclude: [...testExcludes, ...ISOLATED_SUITES] },
      },
      { extends: true, test: { name: 'isolated', include: ISOLATED_SUITES } },
      { extends: true, test: { name: 'dom', include: DOM_SUITES } },
    ],
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
        'packages/core/src/geometry/**': { statements: 90, branches: 85, functions: 90, lines: 90 },
        'packages/core/src/dynamics/**': { statements: 90, branches: 85, functions: 90, lines: 90 },
        'packages/domain-aec/src/**': { statements: 90, branches: 85, functions: 90, lines: 90 },
        'packages/domain-cae/src/**': { statements: 90, branches: 85, functions: 90, lines: 90 },
        'packages/domain-aero/src/**': { statements: 90, branches: 85, functions: 90, lines: 90 },
      },
    },
  },
}));
