/** PHY-00: compare_to_expected / the benchmark judge (VC-VNV-12, 18), the expected-results schema survey and the MMS code verification (VC-VNV-07). */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { createEmptyDocument } from '@core/model/types';
import { adaptLegacyCase, expectedResultsFileSchema, normaliseGrade } from '@cae/vnv/expected';
import { judgeCase, valuesMatch } from '@cae/vnv/judge';
import { expectCase } from './benchmarkCases';
import { mmsErrors } from './mmsPoisson1d';

const PACK = '00-vv-harness';
const doc = createEmptyDocument();

interface Fixture {
  id: string;
  expected: Record<string, unknown>;
  measured: { value: number; unit: string } | null;
  verdict: string;
  code?: string;
  relError?: number;
}

const fixtures = (JSON.parse(readFileSync(`docs/physics/${PACK}/validation/runner_fixtures.json`, 'utf8')) as { fixtures: Fixture[] })
  .fixtures;

describe('compare_to_expected (VC-VNV-12)', () => {
  it('reproduces every runner fixture verdict and code', () => {
    const verdicts = fixtures.map((fixture) => {
      const result = execute(doc, 'compare_to_expected', { expected: { id: fixture.id, ...fixture.expected }, measured: fixture.measured });
      expect(result.document).toBe(doc);
      expect(result.affected).toEqual([]);
      const data = result.data as { verdict: string; code?: string; relError?: number };
      expect(data.code, fixture.id).toBe(fixture.code);
      if (fixture.relError !== undefined) expect(data.relError).toBeCloseTo(fixture.relError, 10);
      return data.verdict;
    });
    expect(verdicts).toEqual(fixtures.map((f) => f.verdict));
    expectCase(PACK, 'VC-VNV-12', verdicts);
  });

  it('refuses a malformed case (VC-VNV-18)', () => {
    const result = execute(doc, 'compare_to_expected', { expected: { id: 'x', value: 1 }, measured: { value: 1, unit: '1' } });
    expect(result.rejected).toBe(true);
    expect(result.error?.code).toBe('VNV_EXPECTED_INVALID');
    expect(result.document).toBe(doc);
    expect(judgeCase({ id: 'x', value: 1, unit: '1', grade: 'Z' }, null).code).toBe('VNV_EXPECTED_INVALID');
    expect(judgeCase({ id: 'x', value: null, unit: '-', grade: 'A' }, null).code).toBe('VNV_EXPECTED_INVALID');
  });

  it('judges lists, records, contracts, tags and absolute temperatures', () => {
    const base = { id: 'c', unit: 'degC', grade: 'A (given the table)', tolerance: { abs: 0.01 } };
    expect(judgeCase({ ...base, value: 0 }, { value: 273.15, unit: 'K' }).verdict).toBe('pass');
    expect(judgeCase({ ...base, value: [0, 100] }, { value: [32, 212], unit: 'degF' }).verdict).toBe('pass');
    expect(judgeCase({ ...base, value: { a: 1 } }, { value: { a: 1, b: 2 }, unit: 'degC' }).verdict).toBe('fail');
    expect(judgeCase({ ...base, unit: 'code', value: 'X', tolerance: { exact: true } }, { value: 'X', unit: 'code' }).verdict).toBe('pass');
    expect(judgeCase({ ...base, unit: 'MPa', value: 1 }, { value: 1, unit: 'furlong' }).code).toBe('VNV_UNIT_MISMATCH');
    const contract = { id: 'k', unit: '-', grade: 'B', value: null, expected: { code: 'X', flags: { a: true } } };
    expect(judgeCase(contract, { value: { code: 'X', flags: { a: true, b: 1 }, extra: 2 }, unit: '-' }).verdict).toBe('pass');
    expect(judgeCase(contract, { value: { code: 'Y' }, unit: '-' })).toMatchObject({ verdict: 'warn', code: 'VNV_BENCHMARK_UNCONFIRMED' });
    expect(judgeCase({ id: 'n', unit: '1', grade: 'A', value: 1, tolerance: { rel: null } }, null).verdict).toBe('skip');
    expect(judgeCase({ id: 'z', unit: '1', grade: 'A', value: 0 }, { value: 0, unit: '1' })).toMatchObject({
      verdict: 'pass',
      absError: 0,
    });
    expect(valuesMatch([1], [1, 2], {})).toBe(false);
    expect(valuesMatch(1, { a: 1 }, {})).toBe(false);
    expect(normaliseGrade('TBD — measure')).toBe('TBD');
  });
});

describe('stable codes and paths (VC-VNV-18)', () => {
  it('returns the §7.1 code, path and remediation for each wrong input', () => {
    const convergence = (input: string, samples: { h: number; value: number }[]): { input: string; code: string; path: string } => {
      const result = execute(doc, 'check_convergence', { quantity: 'q', unit: '1', samples });
      expect(result.error?.remediation).toMatch(/spacings/);
      return { input, code: result.error?.code ?? '', path: result.error?.paths[0] ?? '' };
    };
    const judged = (
      input: string,
      expected: Record<string, unknown>,
      measured: { value: number; unit: string },
    ): { input: string; code: string; path: string } => {
      const result = execute(doc, 'compare_to_expected', { expected, measured });
      const data = result.data as { code?: string; path?: string; remediation?: string } | undefined;
      expect(result.error?.remediation ?? data?.remediation).toBeTruthy();
      return { input, code: result.error?.code ?? data?.code ?? '', path: result.error?.paths[0] ?? data?.path ?? '' };
    };
    const rows = [
      convergence('1 sample', [{ h: 1, value: 1 }]),
      convergence('duplicate h', [
        { h: 1, value: 1 },
        { h: 1, value: 2 },
        { h: 4, value: 3 },
      ]),
      convergence('h = 0', [
        { h: 0, value: 1 },
        { h: 2, value: 2 },
        { h: 4, value: 3 },
      ]),
      convergence('value NaN', [
        { h: 1, value: 1 },
        { h: 2, value: 2 },
        { h: 4, value: Number.NaN },
      ]),
      convergence('2 samples, no assumedOrder', [
        { h: 1, value: 1 },
        { h: 2, value: 2 },
      ]),
      judged(
        'expected case without unit',
        { id: 'x', quantity: 'q', value: 1, tolerance: { rel: 0.01 }, source: 's', grade: 'A', proves: [] },
        { value: 1, unit: '1' },
      ),
      judged(
        'MPa expected, mm measured',
        { id: 'x', quantity: 'q', value: 92.7, unit: 'MPa', tolerance: { rel: 0.02 }, source: 's', grade: 'A', proves: [] },
        { value: 92.7, unit: 'mm' },
      ),
    ];
    expectCase(PACK, 'VC-VNV-18', rows);
  });
});

describe('expected_results.json survey (TR-VNV-07)', () => {
  it('accepts every physics pack file present in the repository', () => {
    const packs = readdirSync('docs/physics').filter((d) => existsSync(`docs/physics/${d}/validation/expected_results.json`));
    expect(packs.length).toBeGreaterThan(15);
    for (const pack of packs) {
      const raw: unknown = JSON.parse(readFileSync(`docs/physics/${pack}/validation/expected_results.json`, 'utf8'));
      const parsed = expectedResultsFileSchema.safeParse(raw);
      expect(parsed.success, `${pack}: ${parsed.success ? '' : JSON.stringify(parsed.error.issues[0])}`).toBe(true);
      for (const c of parsed.data?.cases ?? []) expect(normaliseGrade(c.grade), `${pack} ${c.id}`).not.toBeNull();
    }
  });

  it('adapts the 05 FEA legacy file', () => {
    const legacy = JSON.parse(readFileSync('docs/aerospace/05-fea-cae-handoff/validation/fea_analytic_expected.json', 'utf8')) as {
      cases: unknown[];
    };
    const adapted = legacy.cases.map((c) => adaptLegacyCase(c, ['FR-FEA-01']));
    expect(adapted.every((c) => c !== null)).toBe(true);
    expect(adapted[0]).toMatchObject({ proves: ['FR-FEA-01'] });
    expect(adaptLegacyCase({ nope: true })).toBeNull();
    expect(adaptLegacyCase({ id: 'a', value: 1, unit: 'mm', tolerance_abs: 0.1 })).toMatchObject({ grade: 'B', tolerance: { abs: 0.1 } });
  });
});

describe('method of manufactured solutions, 1D Poisson P1 (VC-VNV-07)', () => {
  it('recovers the formal orders 2 (L2) and 1 (H1) and exact nodal values', () => {
    const rows = [4, 8, 16, 32, 64].map(mmsErrors);
    const [r32, r64] = rows.slice(-2) as [ReturnType<typeof mmsErrors>, ReturnType<typeof mmsErrors>];
    expectCase(PACK, 'VC-VNV-07.a', r64.l2);
    expectCase(PACK, 'VC-VNV-07.b', Math.log(r32.l2 / r64.l2) / Math.LN2);
    expectCase(PACK, 'VC-VNV-07.c', Math.log(r32.h1 / r64.h1) / Math.LN2);
    expectCase(PACK, 'VC-VNV-07.d', Math.max(...rows.map((r) => r.nodalMax)) < 1e-12 ? 0 : 1);
    const csv = readFileSync(`docs/physics/${PACK}/validation/mms_poisson_1d.csv`, 'utf8').trim().split('\n').slice(1);
    csv.forEach((line, i) => expect(Number(line.split(',')[2])).toBeCloseTo(rows[i]?.l2 ?? 0, 12));
  });
});
