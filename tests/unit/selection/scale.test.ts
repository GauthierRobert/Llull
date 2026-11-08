import { describe, expect, it } from 'vitest';
import type { CadDocument } from '@core/model/types';
import { dataOf, run, syntheticDocument } from './fixtures';

/** The synthetic document with `count` clones of syn_a .. syn_e (own keys, distinct ids): the selection budgets of TECHNICAL_SPEC section 8 are about the count of materials. */
function manyMaterials(count: number): { doc: CadDocument; ids: string[] } {
  const base = syntheticDocument();
  const source = Object.values(base.materials).filter((material) => material.name.startsWith('syn_'));
  const materials = { ...base.materials };
  const ids: string[] = [];
  for (let k = 0; k < count; k += 1) {
    const original = source[k % source.length];
    if (original === undefined) continue;
    const id = `m${String(k).padStart(5, '0')}`;
    materials[id] = { ...original, name: id };
    ids.push(id);
  }
  return { doc: { ...base, materials }, ids };
}

const time = (action: () => void): number => {
  const started = performance.now();
  action();
  return performance.now() - started;
};

describe('selection scales linearly with the number of materials', () => {
  it('compare_materials (3 objectives, a constraint, Pareto) over 5x more materials costs about 5x (ratio slack 4x), never a quadratic blow-up', () => {
    const small = manyMaterials(200);
    const large = manyMaterials(1000);
    const params = (ids: string[]): Record<string, unknown> => ({
      materials: ids,
      objectives: [{ index: 'beam_stiffness' }, { index: 'tie_strength', strengthProperty: 'Fty' }, { index: 'panel_stiffness' }],
      constraints: [{ property: 'Fty', min: { value: 100, unit: 'MPa' } }],
      pareto: true,
    });
    run(small.doc, 'compare_materials', params(small.ids));
    const smallMs = Math.min(...[1, 2, 3].map(() => time(() => run(small.doc, 'compare_materials', params(small.ids)))));
    const largeMs = Math.min(...[1, 2, 3].map(() => time(() => run(large.doc, 'compare_materials', params(large.ids)))));
    expect(largeMs / smallMs).toBeLessThan(5 * 4);
    const result = run(large.doc, 'compare_materials', params(large.ids));
    expect((dataOf(result)['ranked'] as unknown[]).length).toBe(1000);
  });

  it('a call with more than 5000 candidates is refused as invalid params (unchanged doc)', () => {
    const doc = syntheticDocument();
    const many = Array.from({ length: 5001 }, (_, k) => `m${k}`);
    for (const [name, params] of [
      ['material_index', { materials: many, indices: ['tie_stiffness'] }],
      ['compare_materials', { materials: many, objectives: [{ index: 'tie_stiffness' }] }],
      ['material_chart_data', { materials: many, x: { property: 'density' }, y: { property: 'E' } }],
    ] as const) {
      const result = run(doc, name, params);
      expect(result.rejected, name).toBe(true);
      expect(result.document).toBe(doc);
    }
  });

  it('the cap also applies to a { library } resolved to more than 5000 materials', () => {
    const { doc } = manyMaterials(5001);
    const materials = Object.fromEntries(
      Object.entries(doc.materials).map(([id, material]) => [
        id,
        id.startsWith('m')
          ? {
              ...material,
              record: {
                id,
                designation: id,
                specs: [],
                licence: 'legacy',
                exportMarking: { regime: 'none' },
                libraryRef: { libraryId: 'big', version: '1', sha256: 'x' },
              },
            }
          : material,
      ]),
    );
    const big = {
      ...doc,
      materials,
      materialLibraries: { big: { libraryId: 'big', version: '1', sha256: 'x' } },
    } as unknown as CadDocument;
    for (const [name, params] of [
      ['compare_materials', { materials: { library: 'big' }, objectives: [{ index: 'tie_stiffness' }] }],
      ['material_chart_data', { materials: { library: 'big' }, x: { property: 'density' }, y: { property: 'E' } }],
    ] as const) {
      const result = run(big, name, params);
      expect(result.error, name).toMatchObject({ code: 'SEL_PARAMS_INVALID', paths: ['materials'] });
      expect(result.document).toBe(big);
    }
  });

  it('material_index over 100 materials x 7 indices answers every row', () => {
    const { doc, ids } = manyMaterials(100);
    const result = run(doc, 'material_index', {
      materials: ids,
      indices: ['tie_stiffness', 'tie_strength', 'beam_stiffness', 'beam_strength', 'panel_stiffness', 'panel_strength', 'column_buckling'],
      strengthProperty: 'Fty',
    });
    expect((dataOf(result)['results'] as unknown[]).length).toBe(700);
    expect(dataOf(result)['excluded']).toEqual([]);
  });
});
