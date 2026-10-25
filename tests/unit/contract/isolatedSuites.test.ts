import { describe, it, expect } from 'vitest';
import { DOM_ISOLATED_SUITES, ISOLATED_SUITES } from '../../isolatedSuites';

const sources = import.meta.glob<string>(['/tests/unit/**/*.test.ts', '/tests/golden/**/*.test.ts'], {
  query: '?raw',
  import: 'default',
  eager: true,
});
const domSources = import.meta.glob<string>(
  [
    '/tests/component/**/*.test.{ts,tsx}',
    '/tests/integration/**/*.test.{ts,tsx}',
    '/tests/production/**/*.test.ts',
    '/tests/unit/**/*.test.tsx',
  ],
  { query: '?raw', import: 'default', eager: true },
);
const uiSources = import.meta.glob<string>(['/src/ui/**/*.ts', '/src/ui/**/*.tsx'], { query: '?raw', import: 'default', eager: true });

// A shared (isolate: false) module graph must not see module mocks, stubbed globals, DOM state or test-only commands.
const NEEDS_ISOLATION =
  /\bvi\.(mock|doMock|stubGlobal|stubEnv|resetModules)\(|\blocalStorage\b|\bwindow\.(location|history|addEventListener)|\bregisterCommands\(|\binstallPlugin\(|\bset(?:EngineLoss|Realism)Law\(/;
// The shared jsdom graph resets renders, stores and storage between tests (tests/setupDom.ts); module mocks, stubs and test-only commands still leak.
const DOM_NEEDS_ISOLATION =
  /\bvi\.(mock|doMock|stubGlobal|stubEnv|resetModules)\(|\bregisterCommands\(|\binstallPlugin\(|\bset(?:EngineLoss|Realism)Law\(/;
// The modules tests/setupDom.ts globs for the stores it resets.
const RESET_STORE_MODULE = /^\/src\/ui\/(.*Store\.ts|store\/store\.ts|store\/kernelStatus\.ts)$/;

const missingFrom = (list: readonly string[], all: Record<string, string>, needs: RegExp): string[] => {
  const listed = new Set(list);
  return Object.entries(all)
    .filter(([path, source]) => needs.test(source) && !listed.has(path.slice(1)))
    .map(([path]) => path.slice(1));
};

describe('isolated test suites', () => {
  it('lists every unit suite that mocks modules, stubs globals, uses the DOM or registers test commands', () => {
    expect(missingFrom(ISOLATED_SUITES, sources, NEEDS_ISOLATION)).toEqual([]);
  });

  it('lists every DOM suite that mocks modules, stubs globals or registers test commands', () => {
    expect(missingFrom(DOM_ISOLATED_SUITES, domSources, DOM_NEEDS_ISOLATION)).toEqual([]);
  });

  it('lists only suites that exist', () => {
    const existing = new Set(Object.keys(sources).map((path) => path.slice(1)));
    expect(ISOLATED_SUITES.filter((path) => !existing.has(path))).toEqual([]);
    const existingDom = new Set(Object.keys(domSources).map((path) => path.slice(1)));
    expect(DOM_ISOLATED_SUITES.filter((path) => !existingDom.has(path))).toEqual([]);
  });

  it('resets every zustand store of the UI between DOM tests (each lives in a module tests/setupDom.ts globs)', () => {
    const stores = Object.entries(uiSources).filter(([, source]) => /from 'zustand'/.test(source) && /\bcreate[<(]/.test(source));
    expect(stores.length).toBeGreaterThan(20);
    expect(stores.map(([path]) => path).filter((path) => !RESET_STORE_MODULE.test(path))).toEqual([]);
  });
});
