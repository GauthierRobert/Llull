/**
 * `llull run_benchmarks` (PHY-00 FR-VNV-11/12, VC-VNV-20): discovery, harness recipes, unit-test measurements, the 05 adapter and the
 * gate exit code, on a throw-away repository layout.
 */
import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runCli, type CliIo } from '../src/cli/main';
import { runBenchmarks } from '../src/cli/benchmarks';

const capture = (): { io: CliIo; out: string[] } => {
  const out: string[] = [];
  const io: CliIo = {
    stdout: (text) => out.push(text),
    stderr: (text) => out.push(text),
    readStdin: () => Promise.resolve(''),
    env: {},
    prepareKernel: () => Promise.resolve(),
  };
  return { io, out };
};

const nasaCall = 'check_convergence quantity=nasa unit=1 samples=[{"h":1,"value":0.9705},{"h":2,"value":0.96854},{"h":4,"value":0.96178}]';

function layout(measuredValue: number): { root: string; measurements: string } {
  const root = mkdtempSync(path.join(tmpdir(), 'llull-bench-'));
  const dir = path.join(root, 'docs', 'physics', '00-test', 'validation');
  mkdirSync(dir, { recursive: true });
  const base = { unit: '1', tolerance: { rel: 1e-9 }, source: 'test', grade: 'A', proves: ['FR-VNV-11'] };
  writeFileSync(
    path.join(dir, 'expected_results.json'),
    JSON.stringify({
      pack: '00-test',
      generatedBy: 'test',
      cases: [
        { ...base, id: 'T-01', quantity: 'p via harness', value: 1.78616959217, harness: { calls: [nasaCall], pointer: '/data/p' } },
        { ...base, id: 'T-02', quantity: 'unit-test measurement', value: 36.6, unit: 'degC', tolerance: { rel: 0.01 } },
        { ...base, id: 'T-03', quantity: 'no measurement', value: 1 },
        { ...base, id: 'T-04', quantity: 'tbd', value: 'TBD', grade: 'TBD' },
        {
          ...base,
          id: 'T-05',
          quantity: 'unsupported alias',
          value: 1,
          harness: { calls: ['fea_solve analysisId=$an'], pointer: '/data' },
        },
        { ...base, id: 'T-06', quantity: 'B drift', value: 1, grade: 'B', tolerance: { rel: 0.01 } },
      ],
    }),
  );
  const broken = path.join(root, 'docs', 'physics', '01-broken', 'validation');
  mkdirSync(broken, { recursive: true });
  writeFileSync(path.join(broken, 'expected_results.json'), JSON.stringify({ pack: '01-broken', cases: [] }));
  mkdirSync(path.join(root, 'quality'));
  mkdirSync(path.join(root, 'legacy'));
  writeFileSync(
    path.join(root, 'legacy', 'fea.json'),
    JSON.stringify({ cases: [{ id: 'L-01', value: 2, unit: 'mm', tolerance_rel: 0.02, sources: ['S1'], derivation: 'x' }] }),
  );
  writeFileSync(
    path.join(root, 'quality', 'physics-benchmarks.json'),
    JSON.stringify({ files: [{ pack: '05-legacy', file: 'legacy/fea.json', adapter: 'fea-legacy', proves: { 'L-01': ['FR-FEA-01'] } }] }),
  );
  const measurements = path.join(root, 'measurements.jsonl');
  writeFileSync(
    measurements,
    [
      { pack: '00-test', caseId: 'T-02', measured: { value: measuredValue, unit: 'degC' } },
      { pack: '00-test', caseId: 'T-06', measured: { value: 2, unit: '1' } },
      { pack: '05-legacy', caseId: 'L-01', measured: { value: 2000, unit: 'um' } },
    ]
      .map((line) => JSON.stringify(line))
      .join('\n') + '\n',
  );
  return { root, measurements };
}

describe('run_benchmarks', () => {
  it('judges harness recipes, measurements and adapted files; skips TBD and unmeasured cases', () => {
    const { root, measurements } = layout(36.9);
    const report = runBenchmarks({ root, measurementsFile: measurements, packs: ['00-test', '05-legacy'] });
    const verdicts = Object.fromEntries(report.rows.map((row) => [row.caseId, [row.verdict, row.code ?? '']]));
    expect(verdicts).toEqual({
      'T-01': ['pass', ''],
      'T-02': ['pass', ''],
      'T-03': ['skip', 'VNV_NO_HARNESS'],
      'T-04': ['skip', 'VNV_EXPECTED_TBD'],
      'T-05': ['error', 'VNV_HARNESS_UNSUPPORTED'],
      'T-06': ['warn', 'VNV_BENCHMARK_UNCONFIRMED'],
      'L-01': ['pass', ''],
    });
    expect(report.gate).toBe('fail');
    const passing = runBenchmarks({ root, measurementsFile: measurements, packs: ['00-test'], caseIds: ['T-01', 'T-02', 'T-06'] });
    expect(passing.gate).toBe('pass');
    expect(runBenchmarks({ root, packs: ['01-broken'] }).rows[0]).toMatchObject({ verdict: 'error', code: 'VNV_EXPECTED_INVALID' });
  });

  it('exits 1 when an A-grade case fails and 0 otherwise, writing JSON + Markdown (VC-VNV-20)', async () => {
    const failing = layout(37.0);
    const save = path.join(failing.root, 'out', 'bench.json');
    const { io, out } = capture();
    const code = await runCli(
      ['run_benchmarks', `root=${failing.root}`, `measurements=${failing.measurements}`, 'packs=00-test', 'caseIds=T-02', '--save', save],
      io,
    );
    expect(code).toBe(1);
    expect(out.join('\n')).toMatch(/gate fail .*fail 00-test T-02 VNV_BENCHMARK_FAILED/s);
    expect(JSON.parse(readFileSync(save, 'utf8'))).toMatchObject({ gate: 'fail' });
    expect(readFileSync(path.join(failing.root, 'out', 'bench.md'), 'utf8')).toContain('| 00-test | T-02 | A | fail |');
    const passing = layout(36.9);
    const ok = capture();
    expect(
      await runCli(
        [
          'run_benchmarks',
          `root=${passing.root}`,
          `measurements=${passing.measurements}`,
          'packs=00-test',
          'grades=A',
          'caseIds=T-01,T-02',
          '--json',
        ],
        ok.io,
      ),
    ).toBe(0);
    expect(JSON.parse(ok.out[0] ?? '{}')).toMatchObject({ ok: true, data: { counts: { pass: 2 } } });
  });
});
