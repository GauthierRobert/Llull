/**
 * Hostile-input harness: every reader of untrusted text or bytes (tests/helpers/hostileReaders.ts) must survive the generic hostile cases
 * (never throw, bounded time) and read in linear time. A new importer / reader that is not in the table fails the completeness check.
 * PR mode (default): every reader gets the cheap structural cases and its format-specific extras (the regression cases of the defects this
 * harness found); the heavy ones (2 MB, 20k records, 2e5 nesting, extra offsets) and the linearity ratio run for a seeded 1-in-6 sample of
 * readers chosen by name hash. Full mode runs everything (nightly in .github/workflows/action-matrix.yml):
 *   HOSTILE_FULL=1 npx vitest run tests/unit/contract/hostileInput.test.ts
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { sampled } from '../../action_matrix/stableHash';
import { listCommands } from '@core/commands/registry';
import { hostileCases } from '../../helpers/hostile/cases';
import { HOSTILE_READERS } from '../../helpers/hostileReaders';
import { EXCLUDED_COMMANDS, EXCLUDED_FUNCTIONS } from '../../helpers/hostile/exclusions';
import { measureLinearity } from '../../helpers/hostile/linearity';

/** PR mode (default): cheap structural cases for every reader; heavy cases and the linearity ratio for 1 reader in SAMPLE (by name hash). */
const FULL = process.env['HOSTILE_FULL'] === '1';
const SAMPLE = 6;
const SEED = 20261026;
const deep = (name: string): boolean => FULL || sampled(name, SAMPLE, SEED);

const CASE_TIMEOUT_MS = 60_000;
const CASE_BUDGET_MS = 4000;
/** 4x the input is 4x the time when linear and 16x when quadratic; 8 leaves room for GC and cache effects. */
const MAX_RATIO = 8;

describe.each(HOSTILE_READERS.map((reader) => [reader.name, reader] as const))('hostile input: %s', (_name, reader) => {
  it.skipIf(reader.costly === true && !deep(reader.name))('accepts its own valid sample (the harness reaches the happy path)', () => {
    expect(reader.accepts(reader.read(reader.build(3)))).toBe(true);
  });

  for (const entry of hostileCases(reader).filter((candidate) => !candidate.heavy || deep(reader.name))) {
    it(
      `never throws and stays bounded: ${entry.name}`,
      () => {
        const input = entry.input();
        const started = performance.now();
        expect(() => reader.read(input)).not.toThrow();
        expect(performance.now() - started).toBeLessThan(reader.budgetMs ?? CASE_BUDGET_MS);
      },
      (reader.budgetMs ?? CASE_BUDGET_MS) + CASE_TIMEOUT_MS,
    );
  }

  it.skipIf(reader.skipLinear !== undefined || !deep(reader.name))(
    'reads in linear time (4n input <= 8x n input)',
    () => {
      const outcome = measureLinearity(reader);
      expect(outcome.ratio, `n=${outcome.records}: ${outcome.small.toFixed(1)} ms -> ${outcome.large.toFixed(1)} ms`).toBeLessThanOrEqual(
        MAX_RATIO,
      );
    },
    CASE_TIMEOUT_MS,
  );
});

const PACKAGES = path.resolve(__dirname, '../../../packages');
const IMPORTER = /^(import_|load_|read_)/;
const READER_FUNCTION = /^export (?:async )?function ((?:read|parse)[A-Z0-9]\w*)/gm;

/** Every `packages/<dir>/src/**.ts` file, relative to `packages/` with forward slashes. */
function sourceFiles(directory: string, found: string[] = []): string[] {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) sourceFiles(full, found);
    else if (entry.name.endsWith('.ts')) found.push(path.relative(PACKAGES, full).split(path.sep).join('/'));
  }
  return found;
}

function exportedReaders(): string[] {
  const keys: string[] = [];
  for (const dir of readdirSync(PACKAGES, { withFileTypes: true }).filter((entry) => entry.isDirectory())) {
    const src = path.join(PACKAGES, dir.name, 'src');
    for (const file of sourceFiles(src)) {
      const text = readFileSync(path.join(PACKAGES, file), 'utf8');
      for (const match of text.matchAll(READER_FUNCTION)) keys.push(`${file}:${match[1] as string}`);
    }
  }
  return keys;
}

describe('hostile input: completeness (a new importer or reader cannot skip the harness)', () => {
  const covered = new Set(HOSTILE_READERS.flatMap((reader) => reader.covers));
  const excluded = new Set([...Object.keys(EXCLUDED_COMMANDS), ...Object.keys(EXCLUDED_FUNCTIONS)]);
  const accounted = (key: string): boolean => covered.has(key) || excluded.has(key);

  it('every import_ / load_ / read_ command is in the table or in the exclusion list', () => {
    const missing = listCommands()
      .map((command) => command.name)
      .filter((name) => IMPORTER.test(name) && !accounted(name));
    expect(
      missing,
      `add these commands to tests/helpers/hostile/*Readers.ts (or EXCLUDED_COMMANDS with a reason): ${missing.join(', ')}`,
    ).toEqual([]);
  });

  it('every exported read* / parse* function of a package is in the table or in the exclusion list', () => {
    const missing = exportedReaders().filter((key) => !accounted(key));
    expect(
      missing,
      `add these readers to tests/helpers/hostile/*Readers.ts (or EXCLUDED_FUNCTIONS with a reason): ${missing.join(', ')}`,
    ).toEqual([]);
  });

  it('every covered or excluded key names an existing command or exported function (no stale entries)', () => {
    const commands = new Set(listCommands().map((command) => command.name));
    const stale = [...covered, ...excluded].filter((key) => {
      if (!key.includes(':')) return !commands.has(key);
      const [file = '', name = ''] = key.split(':');
      try {
        const declaration = new RegExp(String.raw`^export (?:async )?function ${name}\b|^export const ${name}\b`, 'm');
        return !declaration.test(readFileSync(path.join(PACKAGES, file), 'utf8'));
      } catch {
        return true;
      }
    });
    expect(stale).toEqual([]);
  });

  it('table entries have unique names', () => {
    const names = HOSTILE_READERS.map((reader) => reader.name);
    expect(names.filter((name, index) => names.indexOf(name) !== index)).toEqual([]);
  });
});
