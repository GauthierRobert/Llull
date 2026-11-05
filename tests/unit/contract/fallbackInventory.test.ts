import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/** INT-14 (FR-INT-14, TR-INT-14, VC-INT-26): every engineering fallback is inventoried with a test, and new unlisted ones fail the scan. */

const ROOT = resolve(__dirname, '../../..');
const DATA = join(ROOT, 'docs/readiness/10-result-integrity/validation/data');

interface InventoryEntry {
  readonly id: string;
  readonly file: string;
  readonly symbol: string;
  readonly kind: 'default' | 'clamp' | 'nearest' | 'catch-all';
  readonly input: string;
  readonly policy: 'refuse' | 'default-and-report' | 'conservative-neighbour' | 'pending';
  readonly code?: string;
  readonly test?: string;
  readonly reason?: string;
}

interface AllowEntry {
  readonly file: string;
  readonly match: string;
  readonly reason: string;
}

const readJson = <T>(name: string): T => JSON.parse(readFileSync(join(DATA, name), 'utf8')) as T;
const inventory = readJson<{ entries: InventoryEntry[] }>('fallback_inventory.json').entries;
const allowlist = readJson<{ entries: AllowEntry[] }>('fallback_scan_allowlist.json').entries;

/** Patterns of an engineering fallback in check / design / analysis code (TR-INT-14). */
const PATTERNS: ReadonlyArray<RegExp> = [
  /\?\?\s*-?\d/,
  /\|\|\s*-?\d/,
  /\)\s*\?\?\s*\w+\[\w+\.length\s*-\s*1\]/,
  /Math\.abs\([^)]*\)\s*<\s*Math\.abs\(/,
  /:\s*-?\d+(?:\.\d+)?[;,]\s*\/\/\s*default/i,
];

const CHECK_FILE = /(check|design|analysis)/i;

/** Lines of `source` (a check / design / analysis file) that match a fallback pattern; comment lines are skipped. */
function scanSource(source: string): string[] {
  return source
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => !line.startsWith('//') && !line.startsWith('*') && !line.startsWith('/*'))
    .filter((line) => PATTERNS.some((pattern) => pattern.test(line)));
}

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith('.ts') && CHECK_FILE.test(basename(entry.name)) ? [path] : [];
  });
}

const isAllowed = (file: string, line: string): boolean => allowlist.some((entry) => entry.file === file && line.includes(entry.match));

function scanPackages(): Array<{ file: string; line: string }> {
  const packagesDir = join(ROOT, 'packages');
  return readdirSync(packagesDir)
    .filter((name) => name.startsWith('domain-'))
    .flatMap((name) => sourceFiles(join(packagesDir, name, 'src')))
    .flatMap((path) => {
      const file = path.slice(packagesDir.length + 1).replaceAll('\\', '/');
      return scanSource(readFileSync(path, 'utf8')).map((line) => ({ file, line }));
    });
}

describe('fallback inventory (VC-INT-26)', () => {
  it('has unique ids and a known kind and policy per entry', () => {
    expect(new Set(inventory.map((entry) => entry.id)).size).toBe(inventory.length);
    for (const entry of inventory) {
      expect(['default', 'clamp', 'nearest', 'catch-all']).toContain(entry.kind);
      expect(['refuse', 'default-and-report', 'conservative-neighbour', 'pending']).toContain(entry.policy);
      expect(existsSync(join(ROOT, entry.file)), `${entry.id}: ${entry.file} exists`).toBe(true);
    }
  });
  it('gives every non-pending entry a test file that names its id', () => {
    for (const entry of inventory.filter((candidate) => candidate.policy !== 'pending')) {
      expect(entry.test, `${entry.id} names a test`).toBeDefined();
      const path = join(ROOT, entry.test ?? '');
      expect(existsSync(path), `${entry.id}: ${entry.test} exists`).toBe(true);
      expect(readFileSync(path, 'utf8'), `${entry.id} appears in ${entry.test}`).toContain(entry.id);
    }
  });
  it('gives every pending entry a reason', () => {
    for (const entry of inventory.filter((candidate) => candidate.policy === 'pending')) {
      expect(entry.reason?.length ?? 0, `${entry.id} reason`).toBeGreaterThan(20);
    }
  });
  it('seeds the audit defects (steel grade, thickness, bolt class, bolt size, road speed)', () => {
    const codes = inventory.map((entry) => entry.code);
    for (const code of [
      'STL_GRADE_UNKNOWN',
      'STL_THICKNESS_OUT_OF_RANGE',
      'STL_BOLT_CLASS_UNKNOWN',
      'STL_BOLT_SIZE_NONSTANDARD',
      'CIV_SPEED_OUT_OF_TABLE',
    ]) {
      expect(codes).toContain(code);
    }
  });
});

describe('fallback source scan (VC-INT-26)', () => {
  it('reports an unlisted fallback such as `fy ?? 355` in a check file', () => {
    const hits = scanSource('  const fy = yieldOf(grade) ?? 355;\n  // fy ?? 355 in a comment is not code\n');
    expect(hits).toEqual(['const fy = yieldOf(grade) ?? 355;']);
    expect(isAllowed('domain-aec/src/industrial/fixtureCheck.ts', hits[0] ?? '')).toBe(false);
  });
  it('recognises the other fallback shapes', () => {
    expect(scanSource('const row = TABLE.find((r) => r[0] >= v) ?? TABLE[TABLE.length - 1];')).toHaveLength(1);
    expect(scanSource('const best = sizes.reduce((b, s) => (Math.abs(s - d) < Math.abs(b - d) ? s : b));')).toHaveLength(1);
    expect(scanSource('const limit = value || 120;')).toHaveLength(1);
    expect(scanSource('  fy: 355, // default')).toHaveLength(1);
    expect(scanSource('const fy = grade.fy;')).toHaveLength(0);
  });
  it('finds no unlisted fallback in the domain packages', () => {
    const unlisted = scanPackages().filter(({ file, line }) => !isAllowed(file, line));
    expect(
      unlisted,
      'add the fallback to fallback_inventory.json (policy) or, if it is not an engineering input, to fallback_scan_allowlist.json with a reason',
    ).toEqual([]);
  });
  it('has no stale allowlist entry and a real reason for each', () => {
    const hits = scanPackages();
    for (const entry of allowlist) {
      expect(entry.reason.length, `${entry.file}: reason`).toBeGreaterThan(15);
      expect(
        hits.some(({ file, line }) => file === entry.file && line.includes(entry.match)),
        `stale allowlist entry ${entry.file}: ${entry.match}`,
      ).toBe(true);
    }
  });
});
