/**
 * Validation matrix gate of the aerospace packs 07 (sheet metal, machined features) and 08 (materials, standards, libraries): every validation
 * case (VC) listed in a pack README has a record in that pack's RESULTS.json with a status and the tests that run it. A listed test file must
 * exist and mention the VC id; a blocked case needs a stated reason; RESULTS.md is rendered from the JSON and must be up to date.
 *
 *   UPDATE_RESULTS_MD=1 npx vitest run tests/unit/contract/aeroValidationMatrix.test.ts   # rewrite the two RESULTS.md files
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

interface Result {
  status: 'pass' | 'blocked';
  expected: string;
  tolerance: string;
  measured: string;
  tests: string[];
  blockedReason?: string;
}

const root = process.cwd();
const PACKS = [
  { name: '07 sheet metal / machined features', dir: 'docs/aerospace/07-sheet-metal-machined-features/validation', prefix: 'VC-FTR-' },
  { name: '08 materials / standards / libraries', dir: 'docs/aerospace/08-materials-standards-libraries/validation', prefix: 'VC-MAT-' },
] as const;

const read = (path: string): string => readFileSync(resolve(root, path), 'utf8');

/** The VC ids of the README validation table, in order (first cell of each `| VC-… |` row). */
function readmeIds(dir: string): string[] {
  return read(`${dir}/README.md`)
    .split('\n')
    .flatMap((line) => {
      const match = /^\| (VC-(?:FTR|MAT)-\d+b?) \|/.exec(line);
      return match?.[1] !== undefined ? [match[1]] : [];
    });
}

const resultsOf = (dir: string): Record<string, Result> => JSON.parse(read(`${dir}/RESULTS.json`)) as Record<string, Result>;
const mentions = (text: string, id: string): boolean => new RegExp(`${id}(?![0-9A-Za-z])`).test(text);
const cell = (text: string): string => text.replaceAll('|', '/').replaceAll('\n', ' ');

function renderMarkdown(pack: (typeof PACKS)[number], results: Record<string, Result>): string {
  const ids = Object.keys(results);
  const count = (status: Result['status']): number => ids.filter((id) => results[id]?.status === status).length;
  const lines = [
    `# Validation results — pack ${pack.name}`,
    '',
    `Rendered from \`RESULTS.json\` (the machine-readable record that \`tests/unit/contract/aeroValidationMatrix.test.ts\` checks against the cases of \`README.md\`).`,
    `Regenerate with \`UPDATE_RESULTS_MD=1 npx vitest run tests/unit/contract/aeroValidationMatrix.test.ts\`.`,
    '',
    `**${ids.length} cases: ${count('pass')} pass, ${count('blocked')} blocked.** Test paths are relative to the repository root.`,
    '',
    '| VC | Status | Expected (README) | Tolerance | Measured | Tests |',
    '| -- | ------ | ----------------- | --------- | -------- | ----- |',
    ...ids.map((id) => {
      const r = results[id] as Result;
      const tests = r.tests.length > 0 ? r.tests.map((test) => `\`${test}\``).join('<br>') : '—';
      return `| ${id} | ${r.status} | ${cell(r.expected)} | ${cell(r.tolerance)} | ${cell(r.measured)} | ${tests} |`;
    }),
    '',
  ];
  const blocked = ids.filter((id) => results[id]?.status === 'blocked');
  if (blocked.length > 0) {
    lines.push('## Blocked', '');
    for (const id of blocked) lines.push(`- **${id}**: ${(results[id] as Result).blockedReason}`);
    lines.push('');
  }
  return lines.join('\n');
}

describe.each(PACKS)('aerospace validation matrix — pack $name', (pack) => {
  const ids = readmeIds(pack.dir);
  const results = resultsOf(pack.dir);

  it('reads the VC table of the README', () => {
    expect(ids.length).toBeGreaterThan(20);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id.startsWith(pack.prefix), id).toBe(true);
  });

  it('has a record for every README case and no record for a case the README does not list', () => {
    expect(ids.filter((id) => results[id] === undefined)).toEqual([]);
    expect(Object.keys(results).filter((id) => !ids.includes(id))).toEqual([]);
    expect(Object.keys(results)).toEqual(ids);
  });

  it.each(ids)('%s: a status, a measured value and either tests that run it or a reason', (id) => {
    const r = results[id] as Result;
    expect(['pass', 'blocked']).toContain(r.status);
    expect(r.measured.trim().length, `${id}: measured`).toBeGreaterThan(0);
    expect(r.expected.trim().length, `${id}: expected`).toBeGreaterThan(0);
    if (r.status === 'blocked') {
      expect((r.blockedReason ?? '').trim().length, `${id}: a blocked case must say what is missing`).toBeGreaterThan(40);
    } else {
      expect(r.blockedReason, `${id}: a passing case has no blockedReason`).toBeUndefined();
      expect(r.tests.length, `${id}: a passing case lists its tests`).toBeGreaterThan(0);
    }
    for (const test of r.tests) {
      expect(existsSync(resolve(root, test)), `${id}: ${test} exists`).toBe(true);
      const text = read(test);
      expect(mentions(text, id), `${id}: ${test} mentions the id`).toBe(true);
      expect(/\b(?:it|describe|test)\.(?:skip|todo)\(/.test(text), `${id}: ${test} skips tests`).toBe(false);
    }
  });

  it('RESULTS.md is rendered from RESULTS.json and up to date', () => {
    const rendered = renderMarkdown(pack, results);
    const file = resolve(root, pack.dir, 'RESULTS.md');
    if (process.env['UPDATE_RESULTS_MD'] === '1') writeFileSync(file, rendered);
    expect(existsSync(file), 'RESULTS.md exists (UPDATE_RESULTS_MD=1 creates it)').toBe(true);
    expect(readFileSync(file, 'utf8')).toBe(rendered);
  });
});

describe('blocked cases are limited to genuinely external or in-progress causes', () => {
  it('lists every blocked case with its pack, so a new one is a deliberate review decision', () => {
    const blocked = PACKS.flatMap((pack) =>
      Object.entries(resultsOf(pack.dir))
        .filter(([, r]) => r.status === 'blocked')
        .map(([id]) => id),
    );
    expect(blocked).toEqual(['VC-FTR-33', 'VC-FTR-36', 'VC-MAT-18', 'VC-MAT-21']);
  });
});
