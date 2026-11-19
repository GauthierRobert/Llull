import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const repo = path.resolve(__dirname, '../../..');
const work = mkdtempSync(path.join(tmpdir(), 'llull-no-spread-call-'));
afterAll(() => rmSync(work, { recursive: true, force: true }));

/** Lints `source` with only `llull/no-spread-call` on (the real oxlint + the repo plugin); returns the flagged 1-based lines. */
function flaggedLines(source: string): number[] {
  const config = path.join(work, 'oxlintrc.json');
  writeFileSync(
    config,
    JSON.stringify({
      plugins: [],
      jsPlugins: [path.join(repo, 'scripts/lint/llullRules.mjs')],
      categories: { correctness: 'off' },
      rules: { 'llull/no-spread-call': 'error' },
    }),
  );
  const file = path.join(work, 'fixture.ts');
  writeFileSync(file, source);
  const run = spawnSync(path.join(repo, 'node_modules/.bin/oxlint'), ['-c', config, '-f', 'unix', file], { encoding: 'utf8' });
  return [...run.stdout.matchAll(/fixture\.ts:(\d+):\d+:.*no-spread-call/g)].map((match) => Number(match[1]));
}

describe('llull/no-spread-call', () => {
  it('flags every spread argument of Math.max / Math.min / Math.hypot / .push', () => {
    const source = [
      'declare const xs: number[]; declare const out: number[]; declare const o: { list: number[] };',
      'Math.max(...xs);',
      'Math.min(1, ...xs);',
      'Math.hypot(...xs);',
      'out.push(...xs);',
      'o.list.push(0, ...xs, ...xs);',
      'Math.max(...[1, 2]);',
    ].join('\n');
    expect(flaggedLines(source)).toEqual([2, 3, 4, 5, 6, 6, 7]);
  });

  it('leaves calls without a spread, other callees and array-literal spreads alone', () => {
    const source = [
      'declare const xs: number[]; declare const out: number[]; declare const other: { max(...v: number[]): number };',
      'Math.max(1, 2);',
      'out.push(1, 2);',
      'const copy = [...xs];',
      'other.max(...xs);',
      'Math.floor(...([1] as [number]));',
      'console.warn(...xs);',
      'out["push"](...xs);',
    ].join('\n');
    expect(flaggedLines(source)).toEqual([]);
  });
});
