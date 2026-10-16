/** PHY-00: grid-convergence arithmetic and check_convergence against docs/physics/00-vv-harness/validation (VC-VNV-01…09, 18, 19). */
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import type { CommandResult } from '@core/commands/types';
import { createEmptyDocument } from '@core/model/types';
import { classify, observedOrder, representativeSpacing, requiredSpacing, richardson } from '@lib/convergence';
import { expectCase } from './benchmarkCases';

const PACK = '00-vv-harness';
const doc = createEmptyDocument();

type Data = Record<string, unknown> & { codes: string[]; gci21?: { fine: number; coarse: number } };

const study = (
  samples: { h?: number; elements?: number; value: number }[],
  extra: Record<string, unknown> = {},
): { result: CommandResult; data: Data } => {
  const result = execute(doc, 'check_convergence', { quantity: 'q', unit: '1', samples, ...extra });
  return { result, data: result.data as Data };
};

const nasa = [
  { h: 1, value: 0.9705 },
  { h: 2, value: 0.96854 },
  { h: 4, value: 0.96178 },
];

describe('check_convergence (VC-VNV-01…06)', () => {
  it('reproduces the NPARC worked example (VC-VNV-01) with Fs named', () => {
    const { result, data } = study(nasa);
    expect(result.document).toBe(doc);
    expect(result.affected).toEqual([]);
    expect(data['status']).toBe('monotone');
    expectCase(PACK, 'VC-VNV-01.a', data['p'] as number);
    expectCase(PACK, 'VC-VNV-01.b', data['extrapolated'] as number);
    expectCase(PACK, 'VC-VNV-01.c', data.gci21?.fine ?? Number.NaN);
    expectCase(PACK, 'VC-VNV-01.d', data['gci32Fine'] as number);
    expectCase(PACK, 'VC-VNV-01.e', data['asymptoticRatio'] as number);
    expect(data['safetyFactor']).toEqual({ value: 1.25, source: 'Roache 1994; Celik et al. 2008', defaulted: true });
    expect((data['provenance'] as { procedure: string }).procedure).toBe('celik2008-gci');
    expect(result.summary).toMatch(/q: monotone .*estimated discretisation error \(GCI, Fs 1\.25\) 0\.103 %/);
  });

  it('sorts samples finest first', () => {
    const { data } = study([...nasa].reverse());
    expect(data['p']).toBeCloseTo(1.78616959217, 9);
  });

  it('recovers an exact power law with constant and unequal ratios (VC-VNV-02, 03)', () => {
    const law = (h: number): number => 10 + 0.5 * h * h;
    const constant = study([0.1, 0.2, 0.4].map((h) => ({ h, value: law(h) }))).data;
    expectCase(PACK, 'VC-VNV-02.a', constant['p'] as number);
    expectCase(PACK, 'VC-VNV-02.b', constant['extrapolated'] as number);
    expectCase(PACK, 'VC-VNV-02.c', constant.gci21?.fine ?? Number.NaN);
    const unequal = study([0.1, 0.15, 0.3].map((h) => ({ h, value: law(h) }))).data;
    expectCase(PACK, 'VC-VNV-03.a', unequal['p'] as number);
    expectCase(PACK, 'VC-VNV-03.b', unequal['extrapolated'] as number);
  });

  it('classifies oscillatory and divergent samples without extrapolating (VC-VNV-04, 05)', () => {
    const osc = study([
      { h: 1, value: 1 },
      { h: 2, value: 1.02 },
      { h: 4, value: 0.99 },
    ]);
    expect(osc.result.rejected).toBeUndefined();
    expectCase(PACK, 'VC-VNV-04', osc.data['status'] as string);
    expect(osc.data.codes).toContain('VNV_OSCILLATORY');
    expect(osc.data).not.toHaveProperty('extrapolated');
    expect(osc.result.summary).toContain('no extrapolated value');
    const div = study([
      { h: 1, value: 1 },
      { h: 2, value: 1.1 },
      { h: 4, value: 1.15 },
    ]).data;
    expectCase(PACK, 'VC-VNV-05', div['status'] as string);
    expect(div.codes).toContain('VNV_DIVERGENT');
    expect(div).not.toHaveProperty('p');
  });

  it('reproduces the gcat example and warns on an order mismatch (VC-VNV-06)', () => {
    const { data } = study(
      [
        { h: 8.3, value: 1 },
        { h: 10.84, value: 1.02 },
        { h: 14.14, value: 1.08 },
      ],
      { formalOrder: 2 },
    );
    expectCase(PACK, 'VC-VNV-06.a', data['p'] as number);
    expectCase(PACK, 'VC-VNV-06.b', data.gci21?.fine ?? Number.NaN);
    expectCase(PACK, 'VC-VNV-06.c', data.gci21?.coarse ?? Number.NaN);
    expectCase(PACK, 'VC-VNV-06.d', data['gci32Fine'] as number);
    expectCase(PACK, 'VC-VNV-06.e', data['asymptoticRatio'] as number);
    expect(data.codes).toEqual(['VNV_ORDER_MISMATCH']);
    expect(data['formalOrder']).toEqual({ value: 2, source: 'caller', defaulted: false });
  });

  it('reports every consecutive triplet with more than three samples', () => {
    const law = (h: number): number => 10 + 0.5 * h * h;
    const { data } = study([0.1, 0.2, 0.4, 0.8].map((h) => ({ h, value: law(h) })));
    const triplets = data['triplets'] as { levels: number[]; p: number }[];
    expect(triplets.map((t) => t.levels)).toEqual([
      [0, 1, 2],
      [1, 2, 3],
    ]);
    expect(triplets.every((t) => Math.abs(t.p - 2) < 1e-9)).toBe(true);
  });

  it('gives the required spacing and fails the target when GCI is above it (VC-VNV-08)', () => {
    expectCase(PACK, 'VC-VNV-08', requiredSpacing(0.1, 0.4, 2, 4), 'length unit of h');
    const { data } = study(nasa, { gciTarget: 0.0001 });
    expect(data.codes).toContain('VNV_GCI_ABOVE_TARGET');
    expect(data['requiredSpacing']).toBeLessThan(1);
  });

  it('derives h from element counts (VC-VNV-09)', () => {
    expectCase(PACK, 'VC-VNV-09.a', representativeSpacing(1, 1000, 3));
    expectCase(PACK, 'VC-VNV-09.b', representativeSpacing(0.2, 2900, 2) * 1000);
    const { data } = study(
      [
        { elements: 8000, value: 0.9705 },
        { elements: 1000, value: 0.96854 },
        { elements: 125, value: 0.96178 },
      ],
      { measure: 1, dimension: 3 },
    );
    expect(data['p']).toBeCloseTo(1.78616959217, 9);
  });

  it('runs a two-level study with Fs 3 and the two-level flag (VC-VNV-19)', () => {
    const { data } = study(
      [
        { h: 1, value: 0.9705 },
        { h: 2, value: 0.96854 },
      ],
      { assumedOrder: 2 },
    );
    expect(data['status']).toBe('two_level');
    expect((data['safetyFactor'] as { value: number; defaulted: boolean }).value).toBe(3);
    expect(data.codes).toContain('VNV_TWO_LEVEL_ONLY');
    expect(data['extrapolated']).toBeCloseTo((4 * 0.9705 - 0.96854) / 3, 12);
  });

  it('flags a zero finest value and a non-asymptotic or low-ratio study', () => {
    const zero = study([
      { h: 1, value: 0 },
      { h: 2, value: 0.1 },
      { h: 4, value: 0.5 },
    ]).data;
    expect(zero.codes).toContain('VNV_RELATIVE_UNDEFINED');
    expect(zero['gciAbs']).toBeGreaterThan(0);
    const notAsymptotic = study([
      { h: 1, value: 1 },
      { h: 2, value: 1.1 },
      { h: 4, value: 1.5 },
    ]).data;
    expect(notAsymptotic.codes).toContain('VNV_NOT_ASYMPTOTIC');
    const exact = study([
      { h: 1, value: 1 },
      { h: 2, value: 1 },
      { h: 4, value: 1.5 },
    ]).data;
    expect(exact['status']).toBe('converged_exactly');
  });

  it('refuses invalid samples with stable codes and paths (VC-VNV-18)', () => {
    const refusal = (samples: { h?: number; value: number }[], extra: Record<string, unknown> = {}): CommandResult['error'] => {
      const result = study(samples, extra).result;
      expect(result.document).toBe(doc);
      expect(result.rejected).toBe(true);
      return result.error;
    };
    expect(refusal([{ h: 1, value: 1 }])).toMatchObject({ code: 'VNV_SAMPLES_INVALID', paths: ['samples'] });
    expect(
      refusal([
        { h: 1, value: 1 },
        { h: 1, value: 2 },
        { h: 2, value: 3 },
      ])?.code,
    ).toBe('VNV_SAMPLES_INVALID');
    expect(
      refusal([
        { h: 0, value: 1 },
        { h: 1, value: 2 },
      ]),
    ).toMatchObject({ code: 'VNV_SAMPLES_INVALID', paths: ['samples[0].h'] });
    expect(refusal([{ value: 1 }, { h: 1, value: 2 }])).toMatchObject({ paths: ['samples[0]'] });
    expect(
      refusal([
        { h: 1, value: 1 },
        { h: 2, value: 2 },
      ]),
    ).toMatchObject({ code: 'VNV_SAMPLES_INVALID', paths: ['assumedOrder'] });
    expect(
      refusal([
        { h: 1, value: 1 },
        { h: 1.05, value: 2 },
        { h: 2, value: 3 },
      ])?.code,
    ).toBe('VNV_RATIO_TOO_SMALL');
    const nan = study([
      { h: 1, value: Number.NaN },
      { h: 2, value: 1 },
    ]).result;
    expect(nan.rejected).toBe(true);
    const badElements = study(
      [
        { elements: 0, value: 1 },
        { h: 2, value: 1 },
      ],
      { measure: 1, dimension: 3 },
    ).result;
    expect(badElements.error?.paths).toEqual(['samples[0].elements']);
  });
});

describe('lib/convergence', () => {
  it('classifies by the sign and size of e32/e21', () => {
    expect(classify(1, 1, 2).status).toBe('converged_exactly');
    expect(classify(1, 2, 2).status).toBe('converged_exactly');
    expect(classify(1, 2, 4)).toEqual({ status: 'monotone', ratio: 2 });
  });

  it('reports a non-converging order iteration', () => {
    expect(observedOrder(1.5, 2, Number.POSITIVE_INFINITY)).toEqual({ converged: false });
  });

  it('omits the extrapolated relative error when the extrapolated value is 0', () => {
    expect(richardson(1, 3, 2, 1, 1.25)).toMatchObject({ extrapolated: -1 });
    expect(richardson(1, 2, 2, 1, 1.25)).not.toHaveProperty('eext21');
  });
});
