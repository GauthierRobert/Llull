/**
 * Vitest config used ONLY by Stryker (SC-Q4, docs/MUTATION.md): the behavioural judges — oracle parts, golden corpus, fuzz sample,
 * action-matrix PR sample — and nothing that pokes at kernel internals. Same aliases and setup as vite.config.ts.
 */
import { defineConfig } from 'vitest/config';
import { workspaceAliases } from './workspaceAliases.ts';

/**
 * @stryker-mutator/vitest-runner 10.0.0 selects the tests of a mutant with a `testNamePattern` whose words are joined by a space
 * ("suite test"), but vitest 5 matches against "suite > test". Without this every mutant run skips all tests and every mutant survives.
 * The plugin rewrites each assigned pattern so a space also matches the " > " separator.
 */
const separatorTolerantTestNamePattern = {
  name: 'llull-stryker-test-name-pattern',
  configureVitest: ({ project }: { project: { config: { testNamePattern?: RegExp | string } } }): void => {
    let current: RegExp | string | undefined;
    Object.defineProperty(project.config, 'testNamePattern', {
      enumerable: true,
      configurable: true,
      get: () => current,
      set: (pattern: RegExp | string | undefined) => {
        current = pattern instanceof RegExp ? new RegExp(pattern.source.replace(/ /g, '(?: > | )'), pattern.flags) : pattern;
      },
    });
  },
};

export default defineConfig({
  plugins: [separatorTolerantTestNamePattern],
  resolve: { alias: workspaceAliases() },
  test: {
    globals: true,
    environment: 'node',
    setupFiles: './tests/setup.ts',
    testTimeout: 60_000,
    hookTimeout: 120_000,
    include: [
      'tests/oracle/**/*.test.ts',
      'tests/golden/**/*.test.ts',
      'tests/unit/fuzz/fuzzRun.test.ts',
      'tests/action_matrix/actionMatrix.test.ts',
    ],
  },
});
