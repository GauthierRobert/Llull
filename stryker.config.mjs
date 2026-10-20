// Mutation testing (SC-Q4, docs/MUTATION.md). Run through `npm run mutation -- --folder <brep|solids|parametric|history>`
// (scripts/mutation.mjs sets STRYKER_FOLDER). Judges: oracle parts + golden corpus + fuzz sample + action-matrix PR sample ONLY
// (vitest.mutation.config.mts) — never unit tests that touch kernel internals. Nightly, never a PR gate.
const FOLDERS = ['brep', 'solids', 'parametric', 'history'];
const folder = process.env.STRYKER_FOLDER;
const selected = folder === undefined || folder === '' ? FOLDERS : [folder];
if (selected.some((name) => !FOLDERS.includes(name))) throw new Error(`STRYKER_FOLDER must be one of ${FOLDERS.join(', ')}`);

const tag = folder === undefined || folder === '' ? 'all' : folder;

/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  testRunner: 'vitest',
  // related: false — the suites reach the commands through the registry (dynamic), so vitest's static related-file lookup finds no tests.
  vitest: { configFile: 'vitest.mutation.config.mts', related: false },
  plugins: ['@stryker-mutator/vitest-runner'],
  mutate: [
    ...selected.map((name) => `packages/core/src/commands/${name}/**/*.ts`),
    '!**/catalog.ts', // registration tables
    '!**/types.ts', // type-only modules
  ],
  coverageAnalysis: process.env.STRYKER_COVERAGE ?? 'perTest',
  // Incremental state is a CI cache entry (reports/ is gitignored): the file grows with every mutant, so it is not committed.
  incremental: true,
  incrementalFile: `reports/stryker-incremental-${tag}.json`,
  reporters: ['html', 'json', 'clear-text', 'progress'],
  htmlReporter: { fileName: `reports/mutation-${tag}.html` },
  jsonReporter: { fileName: `reports/mutation-${tag}.json` },
  tempDirName: `.stryker-tmp/${tag}`,
  cleanTempDir: 'always',
  concurrency: Number(process.env.STRYKER_CONCURRENCY ?? 8),
  timeoutMS: 60_000,
  timeoutFactor: 3,
  dryRunTimeoutMinutes: 15,
  ignoreStatic: (process.env.STRYKER_COVERAGE ?? 'perTest') === 'perTest',
  thresholds: { high: 80, low: 60, break: null },
};
