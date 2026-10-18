import { describe, it, expect } from 'vitest';
import { ISOLATED_SUITES } from '../../isolatedSuites';

const sources = import.meta.glob<string>(['/tests/unit/**/*.test.ts', '/tests/golden/**/*.test.ts'], {
  query: '?raw',
  import: 'default',
  eager: true,
});

// A shared (isolate: false) module graph must not see module mocks, stubbed globals, DOM state or test-only commands.
const NEEDS_ISOLATION =
  /\bvi\.(mock|doMock|stubGlobal|stubEnv|resetModules)\(|\blocalStorage\b|\bwindow\.(location|history|addEventListener)|\bregisterCommands\(|\binstallPlugin\(/;

describe('isolated test suites', () => {
  it('lists every unit suite that mocks modules, stubs globals, uses the DOM or registers test commands', () => {
    const listed = new Set(ISOLATED_SUITES);
    const missing = Object.entries(sources)
      .filter(([path, source]) => NEEDS_ISOLATION.test(source) && !listed.has(path.slice(1)))
      .map(([path]) => path.slice(1));
    expect(missing).toEqual([]);
  });

  it('lists only suites that exist', () => {
    const existing = new Set(Object.keys(sources).map((path) => path.slice(1)));
    expect(ISOLATED_SUITES.filter((path) => !existing.has(path))).toEqual([]);
  });
});
