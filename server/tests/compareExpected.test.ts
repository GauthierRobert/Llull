/**
 * `llull compare_expected` (PHY-11 validation README "CLI harness", PHY-00 judge): one value of a saved --json answer against one pack case, on
 * throw-away files, plus the real creep pack file.
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runCli, type CliIo } from '../src/cli/main';
import { pointerGet } from '../src/cli/benchmarks';

const capture = (): { io: CliIo; out: string[]; err: string[] } => {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = {
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
    readStdin: () => Promise.resolve(''),
    env: {},
    prepareKernel: () => Promise.resolve(),
  };
  return { io, out, err };
};

const CREEP_PACK = path.resolve(
  __dirname,
  '..',
  '..',
  'docs',
  'physics',
  '11-creep-viscoelasticity',
  'validation',
  'expected_results.json',
);

function files(): { dir: string; answer: string; expected: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'llull-compare-'));
  const answer = path.join(dir, 'report.json');
  writeFileSync(
    answer,
    JSON.stringify({
      ok: true,
      summary: 'creep_report: …',
      data: {
        maxCeeq: { value: 0.319997, at: [0, 0, 0], entityId: 'box-1.1' },
        probes: {
          'pr-14.1': {
            unit: '-',
            history: [
              { tS: 1, value: 3.2e-4 },
              { tS: 1000, value: 0.3215 },
            ],
          },
        },
        hoop: { value: 14.4677, unit: 'MPa' },
      },
    }),
  );
  const expected = path.join(dir, 'expected_results.json');
  writeFileSync(
    expected,
    JSON.stringify({
      pack: '99-test',
      generatedBy: 'test',
      cases: [
        {
          id: 'T-1',
          quantity: 'q',
          value: 0.32,
          unit: '-',
          tolerance: { rel: 0.005 },
          grade: 'A',
          harness: { calls: [], pointer: '/data/maxCeeq/value' },
        },
        { id: 'T-2', quantity: 'q', value: 0.32, unit: '-', tolerance: { rel: 1e-4 }, grade: 'A' },
        { id: 'T-3', quantity: 'kPa', value: 14466.57, unit: 'kPa', tolerance: { rel: 0.03 }, grade: 'A' },
        { id: 'T-4', quantity: 'tbd', value: 'TBD', unit: '-', grade: 'TBD' },
        { id: 'T-5', quantity: 'grade C', value: 1, unit: '-', tolerance: { rel: 0.01 }, grade: 'C' },
      ],
    }),
  );
  return { dir, answer, expected };
}

describe('llull compare_expected', () => {
  it('passes the harness pointer of a case within its tolerance (exit 0) and reports the judgement as --json', async () => {
    const { answer, expected } = files();
    const { io, out } = capture();
    expect(await runCli(['compare_expected', answer, expected, 'T-1', '--json'], io)).toBe(0);
    const reply = JSON.parse(out.join('')) as { ok: boolean; data: { verdict: string; relError: number; pointer: string } };
    expect(reply.ok).toBe(true);
    expect(reply.data).toMatchObject({ verdict: 'pass', pointer: '/data/maxCeeq/value' });
    expect(reply.data.relError).toBeCloseTo(9.375e-6, 9);
  });

  it('reads the last history point with -1 and fails a grade-A case outside its tolerance (exit 1)', async () => {
    const { answer, expected } = files();
    const { io, out } = capture();
    expect(await runCli(['compare_expected', answer, expected, 'T-2', 'pointer=/data/probes/pr-14.1/history/-1/value'], io)).toBe(1);
    expect(out.join('')).toMatch(/^compare_expected 99-test T-2: fail/);
  });

  it('takes the unit of a pointed { value, unit } object and converts it to the case unit', async () => {
    const { answer, expected } = files();
    const { io, out } = capture();
    expect(await runCli(['compare_expected', answer, expected, 'T-3', 'pointer=/data/hoop', '--json'], io)).toBe(0);
    expect(JSON.parse(out.join(''))).toMatchObject({ data: { verdict: 'pass', measured: { value: 14.4677, unit: 'MPa' } } });
  });

  it('a pointer that reaches nothing is verdict error VNV_RESULT_MISSING (exit 1)', async () => {
    const { answer, expected } = files();
    const { io, out } = capture();
    expect(await runCli(['compare_expected', answer, expected, 'T-2', 'pointer=/data/nothing', '--json'], io)).toBe(1);
    expect(JSON.parse(out.join(''))).toMatchObject({ ok: false, data: { verdict: 'error', code: 'VNV_RESULT_MISSING' } });
  });

  it('pointers that reach no own value are VNV_RESULT_MISSING: __proto__, constructor, empty token, -0, 01', async () => {
    const { answer, expected } = files();
    for (const pointer of [
      '/__proto__',
      '/data/constructor',
      '/data/maxCeeq/',
      '/data/probes/pr-14.1/history/-0/value',
      '/data/probes/pr-14.1/history/01/value',
    ]) {
      const { io, out } = capture();
      expect(await runCli(['compare_expected', answer, expected, 'T-2', `pointer=${pointer}`, '--json'], io), pointer).toBe(1);
      expect(JSON.parse(out.join('')), pointer).toMatchObject({ data: { verdict: 'error', code: 'VNV_RESULT_MISSING' } });
    }
  });

  it('a missing value of a TBD or grade-C case is the judge skip (exit 0), not an error', async () => {
    const { answer, expected } = files();
    for (const caseId of ['T-4', 'T-5']) {
      const { io, out } = capture();
      expect(await runCli(['compare_expected', answer, expected, caseId, 'pointer=/data/nothing', '--json'], io), caseId).toBe(0);
      expect(JSON.parse(out.join(''))).toMatchObject({ ok: true, data: { verdict: 'skip', code: 'VNV_EXPECTED_TBD' } });
    }
  });

  it('usage problems exit 2: missing arguments, unknown case, no pointer, unreadable or invalid files', async () => {
    const { dir, answer, expected } = files();
    const bad = path.join(dir, 'bad.json');
    writeFileSync(bad, JSON.stringify({ cases: [] }));
    for (const [argv, text] of [
      [['compare_expected', answer], 'three arguments'],
      [['compare_expected', answer, expected, 'NOPE'], "no case 'NOPE'"],
      [['compare_expected', answer, expected, 'T-2'], 'no harness pointer'],
      [['compare_expected', path.join(dir, 'missing.json'), expected, 'T-1'], 'cannot read'],
      [['compare_expected', answer, bad, 'T-1'], 'not an expected_results file'],
      [['compare_expected', answer, expected, 'T-1', '=x'], 'is not key=value'],
      [['compare_expected', answer, expected, 'T-1', 'pointr=/data'], 'unknown option pointr'],
    ] as const) {
      const { io, err } = capture();
      expect(await runCli([...argv], io), text).toBe(2);
      expect(err.join('')).toContain(text);
    }
  });

  it('judges a FE value against the real creep pack case VC-CRP-10 (VC-CRP-40 number, 0.32 within 0.5 %)', async () => {
    const { answer } = files();
    const { io, out } = capture();
    expect(await runCli(['compare_expected', answer, CREEP_PACK, 'VC-CRP-10', 'pointer=/data/maxCeeq/value'], io)).toBe(0);
    expect(out.join('')).toContain('compare_expected 11-creep-viscoelasticity VC-CRP-10: pass');
  });
});

describe('pointerGet', () => {
  it('reads objects, array indices and negative indices from the end', () => {
    const value = { a: [{ b: 1 }, { b: 2 }, { b: 3 }], 'x/y': 4 };
    expect(pointerGet(value, '/a/0/b')).toBe(1);
    expect(pointerGet(value, '/a/-1/b')).toBe(3);
    expect(pointerGet(value, '/a/-2/b')).toBe(2);
    expect(pointerGet(value, '/x~1y')).toBe(4);
    expect(pointerGet(value, '/a/9/b')).toBeUndefined();
    expect(pointerGet(value, '/a/q')).toBeUndefined();
    for (const pointer of ['/__proto__', '/constructor', '/a/', '/a/-0/b', '/a/01/b', '/a/length'])
      expect(pointerGet(value, pointer), pointer).toBeUndefined();
  });
});
