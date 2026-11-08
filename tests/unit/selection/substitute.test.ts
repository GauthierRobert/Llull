import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import type { CadDocument } from '@core/model/types';
import {
  dataOf,
  expectedCase,
  pinned,
  run,
  step,
  syntheticDocument,
  withBlock,
  withinCase,
  withMaterial,
  workedDocument,
} from './fixtures';

interface Mass {
  readonly beforeG: number;
  readonly afterG: number;
  readonly ratio: number;
  readonly method: string;
}

interface Substitution {
  readonly mass: Mass;
  readonly stiffness?: { ratio: number; deflectionRatio: number; modalFrequencyRatio?: number; bucklingFactorRatio?: number };
  readonly resized?: { dimension: string; factor: number };
  readonly unverified: boolean;
  readonly unverifiedReasons: string[];
  readonly reviewRequired: boolean;
}

const synBlock = withBlock(syntheticDocument(), 'syn_a');
const worked = withBlock(workedDocument(), 'aa7075_t6');
const swap = (
  base: { doc: CadDocument; id: string },
  to: string,
  designRule: string | undefined,
  extra: Record<string, unknown> = {},
): ReturnType<typeof run> =>
  run(base.doc, 'substitute_material', {
    entityIds: [base.id],
    from: base.doc.entities[base.id]?.materialId,
    to,
    ...(designRule === undefined ? {} : { designRule }),
    ...extra,
  });
const sub = (result: ReturnType<typeof run>): Substitution => dataOf(result) as unknown as Substitution;
const ratios = pinned<{ syn_a_to_syn_b: Record<string, number> }>('substitution').syn_a_to_syn_b;
const near = (actual: number | undefined, id: string, value: number): boolean => withinCase(actual ?? Number.NaN, value, id);

describe('substitute_material', () => {
  it('VC-SEL-07: syn_a -> syn_b, same geometry: mass x2 from the real mass path, stiffness, deflection, modal frequency, buckling', () => {
    const result = swap(synBlock, 'syn_b', 'same_geometry');
    const data = sub(result);
    expect(result.rejected).toBeUndefined();
    expect(result.document).toBe(synBlock.doc);
    expect(result.affected).toEqual([]);
    expect(data.mass.method).toBe('same_geometry');
    expect(near(data.mass.beforeG, 'VC-SEL-07.sameGeometryMassRatio', 100)).toBe(true);
    expect(near(data.mass.afterG, 'VC-SEL-07.sameGeometryMassRatio', 200)).toBe(true);
    expect(near(data.mass.ratio, 'VC-SEL-07.sameGeometryMassRatio', ratios['sameGeometryMassRatio'] ?? Number.NaN)).toBe(true);
    expect(near(data.stiffness?.ratio, 'VC-SEL-07.sameGeometryStiffnessRatio', ratios['sameGeometryStiffnessRatio'] ?? Number.NaN)).toBe(
      true,
    );
    expect(
      near(data.stiffness?.deflectionRatio, 'VC-SEL-07.sameGeometryDeflectionRatio', ratios['sameGeometryDeflectionRatio'] ?? Number.NaN),
    ).toBe(true);
    expect(near(data.stiffness?.modalFrequencyRatio, 'VC-SEL-07.modalFrequencyRatio', ratios['modalFrequencyRatio'] ?? Number.NaN)).toBe(
      true,
    );
    expect(near(data.stiffness?.bucklingFactorRatio, 'VC-SEL-07.bucklingFactorRatio', ratios['bucklingFactorRatio'] ?? Number.NaN)).toBe(
      true,
    );
    expect(data.unverified).toBe(false);
    expect(data.reviewRequired).toBe(true);
  });

  it('VC-SEL-07: the equal-stiffness and equal-strength design rules (index_rule method, new size)', () => {
    const beam = sub(swap(synBlock, 'syn_b', 'equal_stiffness_beam'));
    expect(beam.mass.method).toBe('index_rule');
    expect(near(beam.mass.ratio, 'VC-SEL-07.equalStiffnessBeamMassRatio', ratios['equalStiffnessBeamMassRatio'] ?? Number.NaN)).toBe(true);
    expect(beam.mass.afterG).toBeCloseTo(beam.mass.beforeG * beam.mass.ratio, 9);
    expect(beam.stiffness).toEqual({ ratio: 1, deflectionRatio: 1 });
    expect(beam.resized?.dimension).toBe('section side b');
    expect(beam.resized?.factor).toBeCloseTo(Math.pow(70 / 110, 1 / 4), 12);
    const panel = sub(swap(synBlock, 'syn_b', 'equal_stiffness_panel'));
    expect(near(panel.mass.ratio, 'VC-SEL-07.equalStiffnessPanelMassRatio', ratios['equalStiffnessPanelMassRatio'] ?? Number.NaN)).toBe(
      true,
    );
    const tie = sub(swap(synBlock, 'syn_b', 'equal_strength_tie', { strengthProperty: 'Fty' }));
    expect(near(tie.mass.ratio, 'VC-SEL-07.equalStrengthTieMassRatio', ratios['equalStrengthTieMassRatio'] ?? Number.NaN)).toBe(true);
    expect(tie.stiffness).toBeUndefined();
    const tieStiffness = sub(swap(synBlock, 'syn_b', 'equal_stiffness_tie'));
    expect(tieStiffness.mass.ratio).toBeCloseTo((4 / 2) * (70 / 110), 12);
    const beamStrength = sub(swap(synBlock, 'syn_b', 'equal_strength_beam', { strengthProperty: 'Fty' }));
    expect(beamStrength.mass.ratio).toBeCloseTo((4 / 2) * Math.pow(500 / 900, 2 / 3), 12);
    const panelStrength = sub(swap(synBlock, 'syn_b', 'equal_strength_panel', { strengthProperty: 'Fty' }));
    expect(panelStrength.resized?.factor).toBeCloseTo(Math.sqrt(500 / 900), 12);
  });

  it('VC-SEL-10 / 11: the 7075 block is 140.5 g and the same shape in Ti-6Al-4V 221.439 g, unverified (typical / supplier values)', () => {
    const result = swap(worked, 'ti6al4v_annealed', 'same_geometry');
    const data = sub(result);
    expect(near(data.mass.beforeG, 'VC-SEL-10', Number(expectedCase('VC-SEL-10').value))).toBe(true);
    expect(near(data.mass.afterG, 'VC-SEL-11', Number(expectedCase('VC-SEL-11').value))).toBe(true);
    expect(data.unverified).toBe(true);
    expect(data.unverifiedReasons.join(' ')).toContain('aa7075_t6 density');
    expect(data.unverifiedReasons.join(' ')).toContain('ti6al4v_annealed E');
    expect(result.summary).toContain('UNVERIFIED');
    expect(result.summary).toContain('+57.6 %');
  });

  it('VC-SEL-12 / 13: equal-stiffness beam mass ratios of Ti and 4130 against the 7075 block', () => {
    const ti = sub(swap(worked, 'ti6al4v_annealed', 'equal_stiffness_beam'));
    expect(near(ti.mass.ratio, 'VC-SEL-12', Number(expectedCase('VC-SEL-12').value))).toBe(true);
    const steel = sub(swap(worked, 'aisi4130_normalized', 'equal_stiffness_beam'));
    expect(near(steel.mass.ratio, 'VC-SEL-13', Number(expectedCase('VC-SEL-13').value))).toBe(true);
  });

  it('include: mass only needs no E; stiffness only omits the mass', () => {
    const noModulus = withMaterial(synBlock.doc, 'dense', [
      { property: 'density', value: 8, unit: 'g/cm^3', basis: 'company', citation: 'test' },
    ]);
    const massOnly = sub(swap({ doc: noModulus, id: synBlock.id }, 'dense', 'same_geometry', { include: ['mass'] }));
    expect(massOnly.mass.ratio).toBeCloseTo(4, 9);
    expect(massOnly.stiffness).toBeUndefined();
    const stiffnessOnly = dataOf(swap(synBlock, 'syn_b', 'same_geometry', { include: ['stiffness'] }));
    expect(stiffnessOnly['mass']).toBeUndefined();
    expect(stiffnessOnly['stiffness']).toBeDefined();
  });

  it('is pure: the document, its entities and its materials are not touched (the swap is an in-memory copy)', () => {
    const before = structuredClone(worked.doc);
    const result = execute(worked.doc, 'substitute_material', {
      entityIds: [worked.id],
      from: 'aa7075_t6',
      to: 'ti6al4v_annealed',
      designRule: 'same_geometry',
    });
    expect(worked.doc).toEqual(before);
    expect(result.document).toBe(worked.doc);
    expect(worked.doc.entities[worked.id]?.materialId).toBe('aa7075_t6');
  });

  it('refuses a missing rule, a strength rule without its property, unknown / unassigned / empty input and a swap onto itself (unchanged doc)', () => {
    const code = (result: ReturnType<typeof run>): string | undefined => result.error?.code;
    expect(code(swap(synBlock, 'syn_b', undefined))).toBe('SEL_DESIGN_RULE_UNSET');
    expect(code(swap(synBlock, 'syn_b', 'equal_strength_beam'))).toBe('SEL_STRENGTH_PROPERTY_UNSET');
    expect(code(swap(synBlock, 'nope', 'same_geometry'))).toBe('SEL_MATERIAL_NOT_FOUND');
    expect(
      code(run(synBlock.doc, 'substitute_material', { entityIds: ['ghost'], from: 'syn_a', to: 'syn_b', designRule: 'same_geometry' })),
    ).toBe('SEL_ENTITY_NOT_FOUND');
    const wrong = run(synBlock.doc, 'substitute_material', {
      entityIds: [synBlock.id],
      from: 'syn_c',
      to: 'syn_b',
      designRule: 'same_geometry',
    });
    expect(wrong.error).toMatchObject({ code: 'SEL_MATERIAL_NOT_ASSIGNED', ids: [synBlock.id] });
    expect(code(run(synBlock.doc, 'substitute_material', { entityIds: [], from: 'syn_a', to: 'syn_b', designRule: 'same_geometry' }))).toBe(
      'SEL_PARAMS_INVALID',
    );
    expect(code(swap(synBlock, 'syn_a', 'same_geometry'))).toBe('SEL_PARAMS_INVALID');
    expect(swap(synBlock, 'syn_b', undefined).document).toBe(synBlock.doc);
  });

  it('VC-SEL-14: a candidate without density (or without E for the stiffness answer) is refused with SEL_PROPERTY_MISSING, never imputed', () => {
    const cfrp = swap(worked, 'cfrp_t300_5208_quasi_iso', 'same_geometry');
    expect(cfrp.error).toMatchObject({ code: expectedCase('VC-SEL-14').value, ids: ['cfrp_t300_5208_quasi_iso'] });
    const noModulus = withMaterial(synBlock.doc, 'dense', [
      { property: 'density', value: 8, unit: 'g/cm^3', basis: 'company', citation: 'test' },
    ]);
    const refused = swap({ doc: noModulus, id: synBlock.id }, 'dense', 'same_geometry');
    expect(refused.error).toMatchObject({ code: 'SEL_PROPERTY_MISSING', paths: ['E'] });
    expect(refused.document).toBe(noModulus);
  });

  it('a non-solid entity cannot be measured: SEL_ENTITY_NOT_FOUND with the mass_properties reason', () => {
    const line = run(synBlock.doc, 'draw_polyline', {
      points: [
        [0, 0],
        [10, 0],
        [10, 5],
      ],
    });
    const lineId = line.affected[0] ?? '';
    const doc = step(line.document, 'assign_material', { materialName: 'syn_a', entityIds: [lineId] });
    const refused = run(doc, 'substitute_material', { entityIds: [lineId], from: 'syn_a', to: 'syn_b', designRule: 'same_geometry' });
    expect(refused.error?.code).toBe('SEL_ENTITY_NOT_FOUND');
    expect(refused.error?.ids).toEqual([lineId]);
  });
});
