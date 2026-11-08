import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { normaliseWeights, paretoSet } from '@cae/selection/rank';
import { libraryFile } from '../materials/support';
import { dataOf, expectedCase, inputs, pinned, run, step, syntheticDocument, withinCase, withMaterial, workedDocument } from './fixtures';

interface Ranked {
  readonly material: string;
  readonly rank: number;
  readonly score: number;
  readonly objectives: { readonly case: string; readonly value: number }[];
}

const syn = syntheticDocument();
const ids = inputs.synthetic.map((entry) => entry.id);
const beam = { index: 'beam_stiffness' };
const compare = (params: Record<string, unknown>, doc = syn): ReturnType<typeof run> =>
  run(doc, 'compare_materials', { materials: ids, ...params });

describe('compare_materials', () => {
  it('VC-SEL-03: ranks by the beam stiffness index, best scores 1, ties by id; the request order does not matter', () => {
    const result = compare({ objectives: [beam] });
    const ranked = dataOf(result)['ranked'] as Ranked[];
    expect(result.rejected).toBeUndefined();
    expect(result.document).toBe(syn);
    expect(result.affected).toEqual([]);
    expect(ranked.map((entry) => entry.material)).toEqual(expectedCase('VC-SEL-03').value);
    expect(ranked.map((entry) => entry.rank)).toEqual([1, 2, 3, 4, 5]);
    expect(ranked[0]?.score).toBe(1);
    for (const entry of ranked) {
      const caseId = `VC-SEL-02.${entry.material}`;
      expect(withinCase(entry.objectives[0]?.value ?? Number.NaN, Number(expectedCase(caseId).value), caseId)).toBe(true);
    }
    const reversed = dataOf(compare({ objectives: [beam], materials: [...ids].reverse() }))['ranked'] as Ranked[];
    expect(reversed.map((entry) => entry.material)).toEqual(ranked.map((entry) => entry.material));
    expect(result.summary).toContain("best 'syn_d'");
  });

  it('breaks an exact tie by ascending material id', () => {
    const source = (
      property: string,
      value: number,
      unit: string,
    ): { property: string; value: number; unit: string; basis: string; citation: string } => ({
      property,
      value,
      unit,
      basis: 'company',
      citation: 'twin of syn_a',
    });
    const full = withMaterial(syn, 'syn_a2', [source('density', 2.0, 'g/cm^3'), source('E', 70, 'GPa'), source('Fty', 500, 'MPa')]);
    const ranked = dataOf(compare({ objectives: [beam], materials: ['syn_a2', 'syn_a'] }, full))['ranked'] as Ranked[];
    expect(ranked.map((entry) => entry.material)).toEqual(['syn_a', 'syn_a2']);
    expect(ranked[0]?.score).toBe(ranked[1]?.score);
  });

  it('VC-SEL-04: the strength constraint keeps syn_b, syn_c, syn_d and lists the failures with the value', () => {
    const result = compare({ objectives: [beam], constraints: [{ property: 'Fty', min: { value: 550, unit: 'MPa' } }] });
    const data = dataOf(result);
    expect((data['ranked'] as Ranked[]).map((entry) => entry.material).sort()).toEqual(expectedCase('VC-SEL-04').value);
    expect(data['failed']).toEqual([
      { material: 'syn_a', constraint: 'Fty >= 550 MPa', value: 500, unit: 'MPa' },
      { material: 'syn_e', constraint: 'Fty >= 550 MPa', value: 400, unit: 'MPa' },
    ]);
    expect(data['excluded']).toEqual([]);
    // the best survivor scores 1 among the survivors only
    expect((data['ranked'] as Ranked[])[0]).toMatchObject({ material: 'syn_d', score: 1 });
  });

  it('a constraint in another unit of the same dimension, with a max bound', () => {
    const result = compare({
      objectives: [beam],
      constraints: [{ property: 'Fty', min: { value: 72, unit: 'ksi' }, max: { value: 130, unit: 'ksi' } }],
    });
    // 72 ksi = 496.4 MPa, 130 ksi = 896.3 MPa: syn_a (500) passes, syn_b (900) and syn_c (1000) exceed the max, syn_e (400) is under
    expect((dataOf(result)['ranked'] as Ranked[]).map((entry) => entry.material).sort()).toEqual(['syn_a', 'syn_d']);
    expect(dataOf(result)['failed']).toHaveLength(3);
  });

  it('a candidate without a constrained property is excluded (SEL_PROPERTY_MISSING), neither passing nor failing; all excluded warns SEL_NO_CANDIDATE', () => {
    const result = compare({ objectives: [beam], constraints: [{ property: 'Fcy', min: { value: 1, unit: 'MPa' } }] });
    const data = dataOf(result);
    expect(data['ranked']).toEqual([]);
    expect(data['failed']).toEqual([]);
    expect(data['excluded']).toHaveLength(5);
    expect(data['excluded']).toContainEqual(expect.objectContaining({ material: 'syn_a', code: 'SEL_PROPERTY_MISSING', missing: ['Fcy'] }));
    expect((data['warnings'] as { code: string }[]).map((entry) => entry.code)).toContain('SEL_NO_CANDIDATE');
    expect(result.rejected).toBeUndefined();
  });

  it('VC-SEL-06: 0.7 beam stiffness + 0.3 beam strength; the pinned scores and order', () => {
    const result = compare({
      objectives: [
        { ...beam, weight: 0.7 },
        { index: 'beam_strength', strengthProperty: 'Fty', weight: 0.3 },
      ],
    });
    const ranked = dataOf(result)['ranked'] as Ranked[];
    const pin = expectedCase('VC-SEL-06') as unknown as { value: string[]; scores: Record<string, number> };
    expect(ranked.map((entry) => entry.material)).toEqual(pin.value);
    for (const entry of ranked) expect(Math.abs(entry.score - (pin.scores[entry.material] ?? Number.NaN))).toBeLessThan(1e-9);
    expect(dataOf(result)['weights']).toEqual({ value: [0.7, 0.3], defaulted: false });
  });

  it('VC-SEL-22: unspecified weights are equal and reported as a named default with its source', () => {
    const result = compare({ objectives: [beam, { index: 'beam_strength', strengthProperty: 'Fty' }] });
    expect(dataOf(result)['weights']).toEqual({ value: [0.5, 0.5], defaulted: true, source: expect.stringContaining('equal weights') });
    expect(pinned<{ cases: unknown }>('synthetic')).toBeDefined();
    expect((expectedCase('VC-SEL-22').value as { weights: unknown }).weights).toEqual({ value: [0.5, 0.5], defaulted: true });
  });

  it('VC-SEL-05: Pareto set of (relative mass, relative cost) = syn_a, syn_c, syn_d; identical vectors do not dominate each other', () => {
    const pin = expectedCase('VC-SEL-05') as unknown as {
      value: string[];
      relMass: Record<string, number>;
      relCost: Record<string, number>;
    };
    const vectors = Object.keys(pin.relMass).map((id) => ({ id, values: [pin.relMass[id] ?? Number.NaN, pin.relCost[id] ?? Number.NaN] }));
    expect(paretoSet(vectors)).toEqual(pin.value);
    expect(
      paretoSet([
        { id: 'x', values: [1, 1] },
        { id: 'y', values: [1, 1] },
      ]),
    ).toEqual(['x', 'y']);
  });

  it('pareto: true returns the non-dominated candidates of the index objectives (minimising 1/index), ascending ids', () => {
    const single = dataOf(compare({ objectives: [beam], pareto: true }))['pareto'];
    expect(single).toEqual(['syn_d']);
    const two = dataOf(compare({ objectives: [beam, { index: 'tie_strength', strengthProperty: 'Fty' }], pareto: true }))[
      'pareto'
    ] as string[];
    expect(two).toEqual([...two].sort());
    expect(two).toContain('syn_d');
    expect(dataOf(compare({ objectives: [beam] }))['pareto']).toBeUndefined();
  });

  it('VC-SEL-14: the CFRP row without a density is excluded with SEL_PROPERTY_MISSING (missing density), never ranked', () => {
    const result = run(workedDocument(), 'compare_materials', {
      materials: ['aa7075_t6', 'ti6al4v_annealed', 'aisi4130_normalized', 'cfrp_t300_5208_quasi_iso'],
      objectives: [
        { ...beam, weight: 0.7 },
        { index: 'beam_strength', strengthProperty: 'Fty', weight: 0.3 },
      ],
      constraints: [{ property: 'Fty', min: { value: 400, unit: 'MPa' } }],
    });
    const data = dataOf(result);
    expect((data['ranked'] as Ranked[]).map((entry) => entry.material)).toEqual(['aa7075_t6', 'ti6al4v_annealed', 'aisi4130_normalized']);
    expect(data['excluded']).toEqual([
      expect.objectContaining({
        material: 'cfrp_t300_5208_quasi_iso',
        code: expectedCase('VC-SEL-14').value,
        missing: expect.arrayContaining(['density']),
      }),
    ]);
    expect(data['unverified']).toBe(true);
    const codes = (data['warnings'] as { code: string }[]).map((entry) => entry.code);
    expect(codes).toEqual(expect.arrayContaining(['SEL_VALUE_UNVERIFIED', 'SEL_BASIS_MIXED', 'SEL_PROPERTY_MISSING']));
    expect(result.summary).toContain('UNVERIFIED');
  });

  it('{ library } takes every record imported from the library, in id order', () => {
    const doc = step(syn, 'import_material_library', { library: libraryFile() });
    const result = run(doc, 'compare_materials', { materials: { library: 'synthetic-lib' }, objectives: [beam] });
    expect((dataOf(result)['ranked'] as Ranked[]).map((entry) => entry.material)).toEqual(['aa7075_t6']);
  });

  it('is pure', () => {
    const before = structuredClone(syn);
    const result = execute(syn, 'compare_materials', { materials: ids, objectives: [beam], pareto: true });
    expect(syn).toEqual(before);
    expect(result.document).toBe(syn);
  });

  it('refuses no objective, bad weights, unknown materials / library, a strength objective without its property, bad constraints (unchanged doc)', () => {
    const code = (params: Record<string, unknown>): string | undefined => compare(params).error?.code;
    expect(code({ objectives: [] })).toBe('SEL_NO_OBJECTIVE');
    expect(code({ objectives: [{ ...beam, weight: -1 }] })).toBe('SEL_WEIGHT_INVALID');
    expect(code({ objectives: [{ ...beam, weight: 0 }] })).toBe('SEL_WEIGHT_INVALID');
    expect(code({ objectives: [{ ...beam, weight: 1 }, { index: 'tie_stiffness' }] })).toBe('SEL_WEIGHT_INVALID');
    expect(code({ objectives: [{ index: 'beam_strength' }] })).toBe('SEL_STRENGTH_PROPERTY_UNSET');
    expect(code({ objectives: [beam], materials: ['syn_a', 'nope'] })).toBe('SEL_MATERIAL_NOT_FOUND');
    expect(code({ objectives: [beam], materials: { library: 'absent' } })).toBe('SEL_MATERIAL_NOT_FOUND');
    expect(code({ objectives: [beam], constraints: [{ property: 'Fty' }] })).toBe('SEL_PARAMS_INVALID');
    expect(code({ objectives: [beam], constraints: [{ property: 'nope', min: { value: 1, unit: 'MPa' } }] })).toBe('SEL_PARAMS_INVALID');
    expect(code({ objectives: [beam], constraints: [{ property: 'Fty', min: { value: 1, unit: 'kg' } }] })).toBe('SEL_PARAMS_INVALID');
    expect(compare({ objectives: [] }).document).toBe(syn);
  });
});

describe('normaliseWeights', () => {
  it('normalises to sum 1, defaults to equal, refuses invalid sets with a reason', () => {
    expect(normaliseWeights([3, 1])).toEqual({ value: [0.75, 0.25], defaulted: false });
    expect(normaliseWeights([undefined, undefined, undefined])).toMatchObject({ defaulted: true });
    expect(typeof normaliseWeights([1, undefined])).toBe('string');
    expect(typeof normaliseWeights([Number.NaN])).toBe('string');
  });
});
