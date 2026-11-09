/**
 * PHY-06 M4 joint_margins (FR-CNT-12): separation and fastener-ultimate rows from the FE joint curve.
 * Oracle: the synthetic joint of jointFixtures (N = 1000 + 0.2 L, the clamp zone opens between L = 200 and 300): P_sep >= 200 (last closed increment), and
 * N at the factored load 1.15 x 1.4 x 100 = 161 is 1000 + 0.2 x 161 = 1032.2 (linear on the curve).
 */
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { joint, type Jointed } from './jointFixtures';

const FACTORS = { separation: 1.2, ultimate: 1.4, fitting: 1.15, source: 'unit test programme rule (not a design rule)' };

const margins = (j: Jointed, extra: Record<string, unknown> = {}): ReturnType<typeof execute> =>
  execute(
    j.doc,
    'joint_margins',
    {
      analysisId: j.b.analysisId,
      pretension: j.boltId,
      loadProbe: 'pull',
      stepId: j.serviceId,
      designLoad: { value: 100, source: 'unit test load' },
      factors: FACTORS,
      ...extra,
    },
    j.ctx,
  );

type Row = Record<string, unknown> & { ms: number | null; status: string; criterion: string; disposition: string };
type Data = { rows: Row[]; warnings: string[]; omitted: string[]; minMs: number | null };

describe('joint_margins', () => {
  it('separation margin from the last closed increment and the ultimate margin from the bolt force at the factored load, both reviewRequired, pure', () => {
    const j = joint([5, 5, 5, 0, 0]);
    const before = structuredClone(j.doc);
    const result = margins(j, { fastenerAllowable: { value: 2000, source: 'unit test spec' }, marginalBand: 0.5 });
    expect(result.error).toBeUndefined();
    expect(j.doc).toEqual(before);
    expect(result.affected).toEqual([]);
    const data = result.data as Data;
    const [sep, ult] = data.rows;
    expect(sep).toMatchObject({ criterion: 'joint_separation', capacity: 200, separatedAt: 1.75, reviewRequired: true, rowId: 'r1' });
    expect(sep?.ms).toBeCloseTo(200 / (1.15 * 1.2 * 100) - 1, 12);
    expect(sep?.status).toBe('MARGINAL');
    expect(sep?.disposition).toBe('pending_human');
    expect(ult).toMatchObject({ criterion: 'fastener_ultimate', factoredLoad: expect.closeTo(161, 9), reviewRequired: true, rowId: 'r2' });
    expect(ult?.['boltForce']).toBeCloseTo(1032.2, 6);
    expect(ult?.ms).toBeCloseTo(2000 / 1032.2 - 1, 9);
    expect(ult?.status).toBe('PASS');
    expect(ult?.disposition).toBe('none');
    expect(data.minMs).toBeCloseTo(sep?.ms ?? 0, 12);
    expect(data.omitted[0]).toContain('joint_slip');
    expect(result.summary).toContain('joint_separation MS 0.44928');
    expect(result.summary).toContain('not approved');
  });

  it('a joint that never separates is bounded below by the largest load reached; no allowable gives no ultimate row; the missing band is named', () => {
    const j = joint([5, 5, 5, 5, 5]);
    const data = margins(j).data as Data;
    expect(data.rows).toHaveLength(1);
    expect(data.rows[0]).toMatchObject({ capacity: 400, separatedAt: null });
    expect(String(data.rows[0]?.['basis'])).toContain('lower_bound');
    expect(data.rows[0]?.ms).toBeCloseTo(400 / (1.15 * 1.2 * 100) - 1, 12);
    expect(data.warnings.join(' ')).toContain('FEA_MARGINAL_BAND_UNSET');
  });

  it('a negative margin is a FAIL with the code, pending a human disposition', () => {
    const j = joint([5, 5, 5, 0, 0]);
    const data = margins(j, { designLoad: { value: 150, source: 'unit test load' } }).data as Data;
    expect(data.rows[0]).toMatchObject({ status: 'FAIL', code: 'CNT_MS_NEGATIVE', disposition: 'pending_human' });
    expect(data.rows[0]?.ms).toBeLessThan(0);
  });

  it('gives no ultimate row (and says so) when the factored load is beyond the load range of the step', () => {
    const j = joint([5, 5, 5, 5, 5]);
    const data = margins(j, { designLoad: { value: 300, source: 'unit test load' }, fastenerAllowable: { value: 2000, source: 's' } })
      .data as Data;
    expect(data.rows.map((row) => row.criterion)).toEqual(['joint_separation']);
    expect(data.warnings.join(' ')).toContain('outside the load range');
  });

  it.each([
    ['no factors', { factors: {} }, 'CNT_FACTORS_UNSET'],
    ['a factor of 0', { factors: { ...FACTORS, ultimate: 0 } }, 'CNT_FACTORS_UNSET'],
    ['no factor source', { factors: { ...FACTORS, source: ' ' } }, 'CNT_FACTORS_UNSET'],
    ['a design load of 0', { designLoad: { value: 0, source: 's' } }, 'CNT_FACTORS_UNSET'],
    ['a design load without source', { designLoad: { value: 1, source: ' ' } }, 'CNT_FACTORS_UNSET'],
    ['an allowable of 0', { fastenerAllowable: { value: 0, source: 's' } }, 'CNT_INPUT_INVALID'],
    ['an unknown bolt', { pretension: 'nope' }, 'CNT_PRETENSION_NOT_FOUND'],
    ['an unknown probe', { loadProbe: 'nope' }, 'CNT_INPUT_INVALID'],
  ])('refuses %s with %s', (_label, extra, code) => {
    const j = joint([5, 5, 5, 5, 5]);
    const result = margins(j, extra);
    expect(result.error?.code).toBe(code);
    expect(result.document).toEqual(j.doc);
  });

  it('refuses a step without enough increments with the probe load', () => {
    const j = joint([5, 5, 5, 5, 5], { tables: false });
    expect(margins(j).error?.code).toBe('CNT_INPUT_INVALID');
  });

  it('with the separation ignored the capacity would be the largest load: the rule is what makes the joint separate at 200', () => {
    const open = (margins(joint([5, 5, 5, 0, 0])).data as Data).rows[0];
    const closed = (margins(joint([5, 5, 5, 5, 5])).data as Data).rows[0];
    expect(open?.capacity).toBe(200);
    expect(closed?.capacity).toBe(400);
  });
});
