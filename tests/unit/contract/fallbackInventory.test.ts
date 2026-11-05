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
  /** Pending entries only: substring of the scanned source line that this entry tracks (the scan accepts it until the entry is resolved). */
  readonly match?: string;
}

interface AllowEntry {
  readonly file: string;
  readonly match: string;
  readonly reason: string;
}

/** Per-file ratchet for the files outside the check / design / analysis name tier: the hits recorded when the scan was extended. */
interface BaselineEntry {
  readonly file: string;
  readonly hits: number;
  readonly reason: string;
}

const readJson = <T>(name: string): T => JSON.parse(readFileSync(join(DATA, name), 'utf8')) as T;
const inventory = readJson<{ entries: InventoryEntry[] }>('fallback_inventory.json').entries;
const allowlist = readJson<{ entries: AllowEntry[] }>('fallback_scan_allowlist.json').entries;
const baseline = readJson<{ entries: BaselineEntry[] }>('fallback_scan_baseline.json').entries;

/** Patterns of an engineering fallback (TR-INT-14): a numeric `??` / `||` default, a nearest / last-row lookup, a destructuring default. */
const PATTERNS: ReadonlyArray<RegExp> = [
  /\?\?\s*-?\d/,
  /\|\|\s*-?\d/,
  /\)\s*\?\?\s*\w+\[\w+\.length\s*-\s*1\]/,
  /Math\.abs\([^)]*\)\s*<\s*Math\.abs\(/,
  /:\s*-?\d+(?:\.\d+)?[;,]\s*\/\/\s*default/i,
  /[{,]\s*\w+\s*=\s*-?\d[\d.e_]*\s*[,}]/,
  /\(\s*\w+(?::\s*[\w<>[\]| ]+)?\s*=\s*-?\d[\d.]*\s*[,)]/,
  /(?:\?\?|\|\|)\s*['"]S\s?\d{3}/,
];

/**
 * `table[i] ?? 0`, `map.get(k) ?? 0`, `list.at(i) ?? 0`: the additive identity of an absent element (noUncheckedIndexedAccess); not a value
 * substituted for an engineering input. Not exempt when another numeric default follows on the line.
 */
const IDENTITY_ELEMENT = /(\]|\.get\([^)]*\)|\.at\([^)]*\))\??\s*\?\?\s*0\b/;

/** Check / design / analysis files: every hit needs a line entry (allowlist or pending inventory). Other files may also be in the baseline. */
const CHECK_FILE = /(check|design|analysis)/i;

const isProse = (line: string): boolean => /^['"`]/.test(line);

/** Lines of `source` that match a fallback pattern; comment lines, string-literal prose lines and identity-element reads are skipped. */
function scanSource(source: string): string[] {
  return source
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => !line.startsWith('//') && !line.startsWith('*') && !line.startsWith('/*') && !isProse(line))
    .filter((line) => PATTERNS.some((pattern) => pattern.test(line)))
    .filter((line) => !(IDENTITY_ELEMENT.test(line) && !/\|\|\s*-?\d/.test(line) && (line.match(/\?\?\s*-?\d/g) ?? []).length === 1));
}

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts') ? [path] : [];
  });
}

const isPending = (file: string, line: string): boolean =>
  inventory.some(
    (entry) => entry.policy === 'pending' && entry.match !== undefined && entry.file === `packages/${file}` && line.includes(entry.match),
  );

const isAllowed = (file: string, line: string): boolean =>
  allowlist.some((entry) => entry.file === file && line.includes(entry.match)) || isPending(file, line);

interface Hit {
  readonly file: string;
  readonly line: string;
}

/** Every hit in the non-test sources of packages/domain-*, with the tier of its file. */
function scanPackages(): Array<Hit & { checkFile: boolean }> {
  const packagesDir = join(ROOT, 'packages');
  return readdirSync(packagesDir)
    .filter((name) => name.startsWith('domain-'))
    .flatMap((name) => sourceFiles(join(packagesDir, name, 'src')))
    .flatMap((path) => {
      const file = path.slice(packagesDir.length + 1).replaceAll('\\', '/');
      return scanSource(readFileSync(path, 'utf8')).map((line) => ({ file, line, checkFile: CHECK_FILE.test(basename(path)) }));
    });
}

/** Hits no line entry covers: check-tier hits fail outright, other files may stay within their per-file baseline. */
function unlisted(hits: ReadonlyArray<Hit & { checkFile: boolean }>): Hit[] {
  const open = hits.filter(({ file, line }) => !isAllowed(file, line));
  const perFile = new Map<string, number>();
  return open.filter(({ file, checkFile }) => {
    if (checkFile) return true;
    const used = (perFile.get(file) ?? 0) + 1;
    perFile.set(file, used);
    return used > (baseline.find((entry) => entry.file === file)?.hits ?? 0);
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
  it('recognises a destructuring default and skips prose lines and identity-element reads', () => {
    expect(scanSource('const { windPressure = 0.6, snowLoad = 0.8 } = params;')).toHaveLength(1);
    expect(scanSource('run: (doc, { ids, spacingMm = 250 }): CommandResult => {')).toHaveLength(1);
    expect(scanSource("'weights) / γR,h (γR,h = 1.1, EN 1997 DA2) under 1.0G + 1.5 S',")).toHaveLength(0);
    expect(scanSource('const first = lift[0] ?? 0;')).toHaveLength(0);
    expect(scanSource('const total = (sums.get(key) ?? 0) + 1;')).toHaveLength(0);
    expect(scanSource('const fy = table.find((row) => row.grade === grade)?.fy ?? 355;')).toHaveLength(1);
    expect(scanSource('const fy = fyOf[grade] ?? 355;')).toHaveLength(1);
    expect(scanSource("material: spec.material?.trim() || 'S355',")).toHaveLength(1);
    expect(scanSource("const grade = member.material ?? 'S275';")).toHaveLength(1);
  });
  it('scans every non-test source file of packages/domain-*, not only check / design / analysis files', () => {
    const files = new Set(scanPackages().map((hit) => hit.file));
    expect([...files].some((file) => !CHECK_FILE.test(basename(file)))).toBe(true);
    expect([...files].some((file) => file.startsWith('domain-cae/'))).toBe(true);
    expect([...files].some((file) => file.startsWith('domain-aero/'))).toBe(true);
    expect([...files].some((file) => file.startsWith('domain-dynamics/'))).toBe(true);
  });
  it('finds no unlisted fallback in the domain packages', () => {
    expect(
      unlisted(scanPackages()),
      'add the fallback to fallback_inventory.json (policy; a pending entry names its source line in "match") or, if it is not an engineering input, to fallback_scan_allowlist.json with a reason',
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
  it('keeps the per-file baseline tight: every baselined file has exactly its recorded hits, none in a check-tier file', () => {
    const open = scanPackages().filter(({ file, line }) => !isAllowed(file, line));
    for (const entry of baseline) {
      expect(entry.reason.length, `${entry.file}: reason`).toBeGreaterThan(15);
      expect(CHECK_FILE.test(basename(entry.file)), `${entry.file} is a check-tier file: line entries only`).toBe(false);
      const hits = open.filter((hit) => hit.file === entry.file).length;
      expect(hits, `baseline of ${entry.file}: lower it to ${hits} (or raise it only with a reviewed reason)`).toBe(entry.hits);
    }
  });
  it('records every pending entry that tracks a source line against a hit that still exists', () => {
    const hits = scanPackages();
    for (const entry of inventory.filter((candidate) => candidate.policy === 'pending' && candidate.match !== undefined)) {
      expect(
        hits.some(({ file, line }) => `packages/${file}` === entry.file && line.includes(entry.match ?? '')),
        `stale pending entry ${entry.id}`,
      ).toBe(true);
    }
  });
});
