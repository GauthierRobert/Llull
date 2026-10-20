/** 03 GDT M5 / M7: analyze_stackup and fastener_tolerance against stackup_reference.json (VC-GDT-30..36, 55, 58), PMI-linked stacks. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createEmptyDocument } from '@core/model/types';
import type { CadDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { setGeometryKernel } from '@core/geometry/kernel';
import { plateKernel } from '../../helpers/pmiPlateKernel';

const validation = path.resolve(__dirname, '../../../docs/aerospace/03-gdt-mbd-pmi/validation');
interface Contributor {
  name: string;
  nominal: number;
  lower: number;
  upper: number;
  distribution?: string;
}
const su01 = JSON.parse(readFileSync(path.join(validation, 'draft_plan_stackup_su01.json'), 'utf8')) as Array<{
  params: Record<string, unknown>;
}>;
const reference = JSON.parse(readFileSync(path.join(validation, 'stackup_reference.json'), 'utf8')) as {
  stackups: Array<{
    id: string;
    expression: string;
    contributors: Array<Contributor & { sensitivity: number; unit?: string }>;
    analytic: Record<string, unknown>;
  }>;
  fasteners: Array<Record<string, number | string>>;
};

interface Data {
  unit: string;
  nominal: number;
  mean: number;
  worstCase: { min: number; max: number; halfTolerance: number };
  worstCaseExactCorners: { min: number; max: number } | null;
  rss: { halfTolerance: number; min: number; max: number };
  sigma: number;
  pBelow: number | null;
  pAbove: number | null;
  probabilityMethod: string;
  contributions: Array<{ name: string; wcPercent: number; rssPercent: number }>;
  monteCarlo?: { seed: number; samples: number; mean: number; std: number; pBelow?: number; acceptance: { mean: number; std: number } };
  sigmaPerHalfTolerance: { value: number; source: string; defaulted: boolean };
  provenance: { method: string; sensitivitySource: string; note?: string };
  unverified?: { contributors: string[] };
  reviewRequired: boolean;
  reviewReason?: string;
  warnings?: Array<{ code: string }>;
}
const analyze = (
  params: Record<string, unknown>,
  doc: CadDocument = createEmptyDocument(),
): { data: Data; result: ReturnType<typeof execute> } => {
  const result = execute(doc, 'analyze_stackup', params);
  return { data: result.data as Data, result };
};
const stack = (id: string): (typeof reference.stackups)[number] =>
  reference.stackups.find((s) => s.id === id) as (typeof reference.stackups)[number];
const typed = (contributors: Contributor[], verified = true): Array<Contributor & { verified: boolean }> =>
  contributors.map(({ name, nominal, lower, upper, distribution }) => ({
    name,
    nominal,
    lower,
    upper,
    ...(distribution === undefined ? {} : { distribution }),
    verified,
  }));

describe('analyze_stackup against the reference (VC-GDT-30..34)', () => {
  it('SU-01 plan: normal linear stack, expression, autodiff, exact probability, seeded Monte Carlo (VC-GDT-30, 58)', () => {
    const { data, result } = analyze(su01[0]?.params as Record<string, unknown>);
    expect(result.rejected).toBeUndefined();
    expect(data.mean).toBeCloseTo(0.15, 12);
    expect(data.worstCase).toMatchObject({
      halfTolerance: expect.closeTo(0.24, 12),
      min: expect.closeTo(-0.09, 12),
      max: expect.closeTo(0.39, 12),
    });
    expect(data.rss.halfTolerance).toBeCloseTo(0.124096736, 9);
    expect(data.sigma).toBeCloseTo(0.041365579, 9);
    expect(data.pBelow).toBeCloseTo(0.000143809451, 12);
    expect(data.pAbove).toBeNull();
    expect(data.worstCaseExactCorners?.min).toBeCloseTo(-0.09, 12);
    expect(data.sigmaPerHalfTolerance).toMatchObject({ value: 3, defaulted: true });
    expect(data.sigmaPerHalfTolerance.source).not.toBe('');
    expect(data.provenance).toMatchObject({ sensitivitySource: 'autodiff' });
    expect(data.unverified?.contributors).toEqual(['H', 'A', 'B', 'C', 'D']);
    expect(data.warnings?.[0]?.code).toBe('GDT_UNVERIFIED_INPUT');
    expect(data.reviewRequired).toBe(true);
    const mc = data.monteCarlo;
    expect(mc).toMatchObject({ seed: 20261015, samples: 200000 });
    expect(Math.abs((mc?.mean ?? 0) - 0.15)).toBeLessThan(mc?.acceptance.mean ?? 0);
    expect(Math.abs((mc?.std ?? 0) - data.sigma)).toBeLessThan(mc?.acceptance.std ?? 0);
    expect(analyze(su01[0]?.params as Record<string, unknown>).data.monteCarlo).toEqual(mc);
    expect(result.summary).toContain('Monte Carlo 200000 samples seed 20261015');
  });

  it('only the typed contributor flagged verified:false is unverified (VC-GDT-55)', () => {
    const params = su01[0]?.params as { contributors: Contributor[] };
    const contributors = params.contributors.map((c) => ({ ...c, verified: c.name !== 'C' }));
    const { data } = analyze({ ...params, contributors });
    expect(data.unverified?.contributors).toEqual(['C']);
    expect(data.pBelow).toBeCloseTo(0.000143809451, 12);
  });

  it('SU-02 uniform: exact Irwin-Hall probability 29/2400 (VC-GDT-31)', () => {
    const s = stack('SU-02');
    const { data } = analyze({ expression: 'H - (A + B + C + D)', contributors: typed(s.contributors), lowerSpecLimit: 0 });
    expect(data.sigma).toBeCloseTo(0.071647284, 9);
    expect(data.pBelow).toBeCloseTo(29 / 2400, 12);
    expect(data.probabilityMethod).toContain('Irwin-Hall');
  });

  it('SU-03 and SU-04 linear stacks with sensitivities (VC-GDT-32, 33)', () => {
    const s3 = stack('SU-03');
    const three = analyze({
      contributors: s3.contributors.map((c, i) => ({ ...c, sensitivity: i === 0 ? 1 : -1, verified: true })),
      lowerSpecLimit: 0,
    }).data;
    expect(three.worstCase.min).toBeCloseTo(0.007, 12);
    expect(three.rss.halfTolerance).toBeCloseTo(0.012349089, 9);
    expect(three.pBelow).toBeCloseTo(2.765e-9, 12);
    expect(analyze({ contributors: typed(s3.contributors) }).data.provenance.note).toContain('no sensitivities given');
    const s4 = stack('SU-04');
    const four = analyze({
      contributors: s4.contributors.map((c) => ({ ...c, sensitivity: (c as { sensitivity: number }).sensitivity, verified: true })),
      lowerSpecLimit: 0,
    }).data;
    expect(four.worstCase.min).toBeCloseTo(-0.035, 12);
    expect(four.rss.halfTolerance).toBeCloseTo(0.044440972, 9);
    expect(four.pBelow).toBeCloseTo(0.000368724955, 12);
    expect(four.contributions.reduce((s, c) => s + c.rssPercent, 0)).toBeCloseTo(100, 9);
  });

  it('SU-05 non-linear: autodiff worst case, exact corners and a deterministic Monte Carlo (VC-GDT-34)', () => {
    const s = stack('SU-05');
    const { data } = analyze({
      expression: 'L * sin(theta_deg * pi / 180)',
      contributors: typed(s.contributors),
      methods: ['worstCase', 'rss', 'monteCarlo'],
      samples: 20000,
      seed: 7,
    });
    expect(data.worstCase.min).toBeCloseTo(49.194250265, 9);
    expect(data.worstCaseExactCorners?.min).toBeCloseTo(49.193113654, 9);
    expect(data.worstCaseExactCorners?.max).toBeCloseTo(50.804590132, 9);
    expect(data.sigma).toBeCloseTo(0.252467305, 9);
    expect(data.monteCarlo?.samples).toBe(20000);
    expect(data.pBelow).toBeNull();
  });

  it('mixed distributions have no closed-form probability; Monte Carlo reports pAbove', () => {
    const s = stack('SU-01');
    const contributors = typed(s.contributors).map((c, i) => ({ ...c, distribution: i === 0 ? 'uniform' : 'normal' }));
    const { data } = analyze({
      expression: 'H - (A + B + C + D)',
      contributors,
      lowerSpecLimit: 0,
      upperSpecLimit: 0.3,
      methods: ['monteCarlo'],
      samples: 5000,
    });
    expect(data.pBelow).toBeNull();
    expect(data.probabilityMethod).toContain('not available');
    expect(data.monteCarlo).toBeDefined();
  });
});

describe('analyze_stackup refusals', () => {
  const base = typed(stack('SU-03').contributors);
  const code = (params: Record<string, unknown>, doc?: CadDocument): string | undefined => analyze(params, doc).result.error?.code;

  it('reports each coded refusal and leaves the document untouched', () => {
    expect(code({ expression: 'Dhole - ', contributors: base })).toBe('GDT_STACKUP_EXPRESSION');
    expect(code({ expression: 'Dhole - Missing', contributors: base })).toBe('GDT_STACKUP_EXPRESSION');
    expect(code({ expression: '1 / (Dhole - Dhole)', contributors: base })).toBe('GDT_STACKUP_EXPRESSION');
    expect(code({ expression: 'Dhole - Dpin', contributors: base.map((c) => ({ ...c, name: `${c.name} x` })) })).toBe(
      'GDT_STACKUP_EXPRESSION',
    );
    expect(code({ expression: 'Dhole - Dpin', contributors: base.map((c) => ({ ...c, sensitivity: 1 })) })).toBe(
      'GDT_STACKUP_SENSITIVITY_CONFLICT',
    );
    expect(code({ contributors: base, methods: ['monteCarlo'], samples: 2_000_001 })).toBe('GDT_STACKUP_SAMPLES_CAP');
    expect(code({ contributors: [base[0], base[0]] })).toBe('GDT_STACKUP_INVALID');
    expect(code({ contributors: [{ name: 'a', nominal: 1, lower: 2, upper: 1 }] })).toBe('GDT_STACKUP_INVALID');
    expect(code({ contributors: [{ name: 'a' }] })).toBe('GDT_STACKUP_INVALID');
    expect(code({ contributors: base, lowerSpecLimit: 2, upperSpecLimit: 1 })).toBe('GDT_STACKUP_INVALID');
    expect(code({ contributors: [{ name: 'a', pmiId: 'ghost' }] })).toBe('GDT_PMI_UNKNOWN');
    const doc = createEmptyDocument();
    expect(analyze({ contributors: base }, doc).result.document).toBe(doc);
  });
});

describe('PMI-linked contributors (VC-GDT-36)', () => {
  beforeEach(() => setGeometryKernel(plateKernel()));
  afterEach(() => setGeometryKernel(null));

  function plate(): { doc: CadDocument; id: string } {
    const box = execute(createEmptyDocument(), 'add_box', { size: [120, 80, 12] });
    return { doc: box.document, id: box.affected[0] as string };
  }

  it('the stack follows the PMI: bore 20 +0.021/0 against a typed pin, then after an edit', () => {
    const { doc, id } = plate();
    const bore = execute(doc, 'add_size_dimension', {
      entityId: id,
      facesNear: [[50, 40, 6]],
      sizeKind: 'diameter',
      tolerance: { type: 'plusMinus', upper: 0.021, lower: 0 },
    });
    const boreId = bore.affected[0] as string;
    const params = {
      contributors: [
        { name: 'bore', pmiId: boreId, sensitivity: 1 },
        { name: 'pin', nominal: 20, upper: -0.007, lower: -0.02, sensitivity: -1, verified: true },
      ],
      lowerSpecLimit: 0,
    };
    const first = analyze(params, bore.document).data;
    expect(first.worstCase.min).toBeCloseTo(0.007, 9);
    expect(first.worstCase.max).toBeCloseTo(0.041, 9);
    expect(first.rss.halfTolerance).toBeCloseTo(0.012349089, 9);
    expect(first.unverified).toBeUndefined();
    expect(first.reviewRequired).toBe(true);
    expect(first.reviewReason).toContain(boreId);
    const edited = execute(bore.document, 'update_pmi', { pmiId: boreId, tolerance: { type: 'plusMinus', upper: 0.025, lower: 0 } });
    expect(analyze(params, edited.document).data.worstCase.max).toBeCloseTo(0.045, 9);
  });

  it('takes limits, radius sizes and location dimensions, and refuses basic / non-dimension items', () => {
    const { doc, id } = plate();
    const limits = execute(doc, 'add_size_dimension', {
      entityId: id,
      facesNear: [[16.7, 20, 6]],
      sizeKind: 'radius',
      tolerance: { type: 'limits', lower: 3.2, upper: 3.4 },
    });
    const loc = execute(limits.document, 'add_location_dimension', {
      entityId: id,
      from: [[60, 0, 6]],
      to: [[16.7, 20, 6]],
      measure: 'distance',
      tolerance: { type: 'plusMinus', upper: 0.1, lower: -0.1 },
    });
    const basic = execute(loc.document, 'add_location_dimension', {
      entityId: id,
      from: [[60, 0, 6]],
      to: [[60, 80, 6]],
      measure: 'distance',
    });
    const datum = execute(basic.document, 'add_datum_feature', { entityId: id, facesNear: [[30, 10, 0]] });
    const [sizeId, locId, basicId, datumId] = [limits.affected[0], loc.affected[0], basic.affected[0], datum.affected[0]] as string[];
    const stackDoc = datum.document;
    const run = analyze(
      {
        contributors: [
          { name: 'r', pmiId: sizeId },
          { name: 'd', pmiId: locId, unit: 'length' },
        ],
      },
      stackDoc,
    ).data;
    expect(run.mean).toBeCloseTo(3.3 + 20, 9);
    expect(analyze({ contributors: [{ name: 'r', pmiId: sizeId }] }, stackDoc).data.worstCase.halfTolerance).toBeCloseTo(0.1, 9);
    const refused = (pmiId: string): string | undefined => analyze({ contributors: [{ name: 'x', pmiId }] }, stackDoc).result.error?.code;
    expect(refused(basicId as string)).toBe('GDT_STACKUP_CONTRIBUTOR_UNTOLERANCED');
    expect(refused(datumId as string)).toBe('GDT_STACKUP_CONTRIBUTOR_UNTOLERANCED');
    const unresolved = JSON.parse(JSON.stringify(stackDoc)) as { pmi: { items: Record<string, { feature: { ofSize?: unknown } }> } };
    delete unresolved.pmi.items[sizeId as string]?.feature.ofSize;
    expect(analyze({ contributors: [{ name: 'x', pmiId: sizeId }] }, unresolved as unknown as CadDocument).result.error?.code).toBe(
      'GDT_STACKUP_CONTRIBUTOR_UNTOLERANCED',
    );
  });
});

describe('fastener_tolerance (VC-GDT-35)', () => {
  const run = (params: Record<string, unknown>): { result: ReturnType<typeof execute>; data: Record<string, unknown> } => {
    const result = execute(createEmptyDocument(), 'fastener_tolerance', params);
    return { result, data: result.data as Record<string, unknown> };
  };

  it('FF-01 floating, FF-02 fixed equal split and unequal split', () => {
    expect(
      (run({ holeMmc: 6.6, fastenerMmc: 6, type: 'floating' }).data['positionTolerance'] as { eachPart: number }).eachPart,
    ).toBeCloseTo(0.6, 12);
    const fixed = run({ holeMmc: 6.6, fastenerMmc: 6, type: 'fixed' }).data['positionTolerance'] as {
      part1: number;
      part2: number;
      total: number;
    };
    expect(fixed.part1).toBeCloseTo(0.3, 12);
    expect(fixed.part2).toBeCloseTo(0.3, 12);
    const split = run({ holeMmc: 6.6, fastenerMmc: 6, type: 'fixed', split: 0.25 }).data['positionTolerance'] as {
      part1: number;
      part2: number;
    };
    expect(split.part1).toBeCloseTo(0.15, 12);
    expect(split.part2).toBeCloseTo(0.45, 12);
  });

  it('FF-03 bonus, allowed position and virtual condition', () => {
    const at = (actualSize: number): Record<string, number> =>
      run({ holeMmc: 6.6, fastenerMmc: 6, type: 'floating', holeLmc: 6.9, statedPosition: 0.3, actualSize }).data as Record<string, number>;
    expect(at(6.6)['allowedPosition']).toBeCloseTo(0.3, 12);
    expect(at(6.9)['allowedPosition']).toBeCloseTo(0.6, 12);
    expect(at(6.75)['allowedPosition']).toBeCloseTo(0.45, 12);
    expect(at(6.75)['bonus']).toBeCloseTo(0.15, 12);
    expect(at(6.75)['virtualCondition']).toBeCloseTo(6.3, 12);
    expect(at(6.75)['allowedPositionAtLmc']).toBeCloseTo(0.6, 12);
    expect(run({ holeMmc: 6.6, fastenerMmc: 6, type: 'fixed', statedPosition: 0.2 }).data['statedWithinClearance']).toBe(true);
    expect(run({ holeMmc: 6.6, fastenerMmc: 6, type: 'floating', statedPosition: 0.9 }).data['statedWithinClearance']).toBe(false);
    const flexible = run({ holeMmc: 6.6, fastenerMmc: 6, type: 'fixed', split: 0.9, statedPosition: 0.5 });
    expect(flexible.result.summary).toContain('virtual condition 6.1');
  });

  it('refuses without clearance and for invalid inputs, with codes', () => {
    const code = (params: Record<string, unknown>): string | undefined => run(params).result.error?.code;
    expect(code({ holeMmc: 6, fastenerMmc: 6, type: 'floating' })).toBe('GDT_FASTENER_HOLE_LE_FASTENER');
    expect(code({ holeMmc: 6.6, fastenerMmc: 6, type: 'floating', holeLmc: 6.5 })).toBe('GDT_FASTENER_INVALID');
    expect(code({ holeMmc: 6.6, fastenerMmc: 6, type: 'fixed', split: 1 })).toBe('GDT_FASTENER_INVALID');
    expect(code({ holeMmc: 6.6, fastenerMmc: 6, type: 'fixed', statedPosition: 0 })).toBe('GDT_FASTENER_INVALID');
    expect(code({ holeMmc: 6.6, fastenerMmc: 6, type: 'fixed', actualSize: 6.7 })).toBe('GDT_FASTENER_INVALID');
    expect(code({ holeMmc: 6.6, fastenerMmc: 6, type: 'fixed', statedPosition: 0.3, actualSize: 6.5 })).toBe('GDT_FASTENER_INVALID');
    expect(code({ holeMmc: 6.6, fastenerMmc: 6, type: 'fixed', holeLmc: 6.9, statedPosition: 0.3, actualSize: 7 })).toBe(
      'GDT_FASTENER_INVALID',
    );
  });
});
