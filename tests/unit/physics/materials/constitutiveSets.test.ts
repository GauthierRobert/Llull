/** define_constitutive_set and delete_material_model: combination rules (VC-MATL-15), defaults, purity. */
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { GPa, MPa, NL1_ELASTIC, NL1_PERFECT, ONE, addModel, codeOf, defineSet, run, withMaterial } from './materialFixtures';

describe('define_constitutive_set and delete_material_model', () => {
  const rubber = (): CadDocument => {
    let doc = withMaterial(createEmptyDocument(), 'm');
    doc = addModel(doc, 'm', 'elastic', NL1_ELASTIC);
    doc = addModel(doc, 'm', 'plastic', NL1_PERFECT);
    doc = addModel(doc, 'm', 'hyper', { kind: 'hyper_neo_hooke', C10: MPa(0.2), D1: { value: 0, unit: '1/MPa' } });
    doc = addModel(doc, 'm', 'ro', {
      kind: 'ramberg_osgood',
      form: 'calculix',
      E: GPa(72),
      nu: ONE(0.33),
      sigma0: MPa(400),
      n: 15,
      alpha: 0.36,
    });
    doc = addModel(doc, 'm', 'visco', { kind: 'visco_prony', shear: [{ g: 0.3, tau: { value: 1, unit: 's' } }] });
    doc = addModel(doc, 'm', 'creep', { kind: 'creep_norton', A: 1e-10, n: 5, m: 0, stressUnit: 'MPa', timeUnit: 'h', hardening: 'time' });
    doc = addModel(doc, 'm', 'ortho', {
      kind: 'elastic_orthotropic',
      E1: MPa(1000),
      E2: MPa(500),
      E3: MPa(500),
      nu12: ONE(0.2),
      nu13: ONE(0.2),
      nu23: ONE(0.2),
      G12: MPa(300),
      G13: MPa(300),
      G23: MPa(200),
    });
    doc = addModel(doc, 'm', 'voce', {
      kind: 'j2_plasticity',
      isotropic: { kind: 'voce', yieldStress: MPa(5), Q: MPa(5), b: 10 },
      kinematic: { kind: 'none' },
    });
    doc = addModel(doc, 'm', 'jcrate', { kind: 'rate_johnson_cook', C: 0.01, referenceRate: { value: 1, unit: '1/s' } });
    return doc;
  };
  const set = (doc: CadDocument, body: Record<string, unknown>, extra: Record<string, unknown> = {}): string =>
    codeOf(doc, 'define_constitutive_set', { material: 'm', set: { id: 's', ...body }, ...extra });

  it('defines, replaces and defaults a set, and is pure', () => {
    const doc = rubber();
    const snapshot = structuredClone(doc);
    const result = execute(doc, 'define_constitutive_set', {
      material: 'm',
      set: { id: 's', elastic: 'elastic', plastic: 'plastic' },
      makeDefault: true,
    });
    expect(doc).toEqual(snapshot);
    expect(result.affected).toEqual([]);
    expect(result.summary).toContain("define_constitutive_set 'm/s': elastic=elastic, plastic=plastic; default set");
    expect(result.document.materials['m']?.defaultConstitutiveSet).toBe('s');
    expect(codeOf(result.document, 'define_constitutive_set', { material: 'm', set: { id: 's', elastic: 'elastic' } })).toBe(
      'MATL_MODEL_EXISTS',
    );
    const replaced = run(result.document, 'define_constitutive_set', {
      material: 'm',
      set: { id: 's', elastic: 'elastic' },
      replace: true,
    });
    expect(replaced.document.materials['m']?.constitutiveSets).toEqual([{ id: 's', elastic: 'elastic' }]);
    expect(replaced.document.materials['m']?.defaultConstitutiveSet).toBe('s');
    expect(replaced.summary).toContain('(replaced)');
  });

  it('enforces the combination rules (VC-MATL-15)', () => {
    const doc = rubber();
    expect(set(doc, { elastic: 'elastic', hyperelastic: 'hyper' })).toBe('MATL_COMBINATION_INVALID');
    expect(set(doc, { creep: 'creep' })).toBe('MATL_COMBINATION_INVALID');
    expect(set(doc, {})).toBe('MATL_COMBINATION_INVALID');
    expect(set(doc, { elastic: 'elastic', plastic: 'ro' })).toBe('MATL_COMBINATION_INVALID');
    expect(set(doc, { hyperelastic: 'hyper', plastic: 'ro' })).toBe('MATL_COMBINATION_INVALID');
    expect(set(doc, { plastic: 'ro' })).toBe('accepted');
    expect(set(doc, { hyperelastic: 'hyper', plastic: 'plastic' })).toBe('MATL_COMBINATION_INVALID');
    expect(set(doc, { elastic: 'hyper' })).toBe('MATL_COMBINATION_INVALID');
    expect(set(doc, { elastic: 'ortho', plastic: 'plastic' })).toBe('accepted');
    expect(set(doc, { elastic: 'ortho', plastic: 'voce' })).toBe('MATL_COMBINATION_INVALID');
    expect(set(doc, { elastic: 'elastic', plastic: 'voce' })).toBe('accepted');
    expect(set(doc, { elastic: 'elastic', plastic: 'ro', creep: 'creep' })).toBe('MATL_COMBINATION_INVALID');
    expect(set(doc, { elastic: 'elastic', viscoelastic: 'visco', creep: 'creep' })).toBe('accepted');
    expect(set(doc, { hyperelastic: 'hyper', viscoelastic: 'visco' })).toBe('accepted');
    expect(set(doc, { plastic: 'ro', viscoelastic: 'visco' })).toBe('MATL_COMBINATION_INVALID');
    expect(set(doc, { elastic: 'elastic', rate: 'jcrate' })).toBe('MATL_COMBINATION_INVALID');
    expect(set(doc, { elastic: 'elastic', plastic: 'plastic', rate: 'jcrate' })).toBe('MATL_COMBINATION_INVALID');
    expect(set(doc, { elastic: 'ghost' })).toBe('MATL_MODEL_NOT_FOUND');
    expect(codeOf(doc, 'define_constitutive_set', { material: 'nope', set: { id: 's', elastic: 'elastic' } })).toBe('MAT_RECORD_NOT_FOUND');
  });

  it('accepts a Johnson-Cook rate only on Johnson-Cook hardening', () => {
    let doc = rubber();
    doc = addModel(doc, 'm', 'jc', {
      kind: 'j2_plasticity',
      isotropic: {
        kind: 'johnson_cook',
        A: MPa(500),
        B: MPa(300),
        n: 0.3,
        m: 1,
        meltTemperature: { value: 1800, unit: 'K' },
        transitionTemperature: { value: 293, unit: 'K' },
      },
      kinematic: { kind: 'none' },
    });
    expect(set(doc, { elastic: 'elastic', plastic: 'jc', rate: 'jcrate' })).toBe('accepted');
    expect(set(doc, { elastic: 'ortho', plastic: 'jc', rate: 'jcrate' })).toBe('MATL_COMBINATION_INVALID');
  });

  it('removes unused models and refuses models a set lists', () => {
    const doc = defineSet(rubber(), 'm', { id: 's', elastic: 'elastic', plastic: 'plastic' });
    const removed = run(doc, 'delete_material_model', { material: 'm', id: 'hyper' });
    expect(removed.document.materials['m']?.materialModels?.some((m) => m.id === 'hyper')).toBe(false);
    expect(removed.summary).toContain("delete_material_model 'm/hyper': removed.");
    expect(codeOf(doc, 'delete_material_model', { material: 'm', id: 'plastic' })).toBe('MATL_MODEL_IN_USE');
    expect(codeOf(doc, 'delete_material_model', { material: 'm', id: 'nope' })).toBe('MATL_MODEL_NOT_FOUND');
    expect(codeOf(doc, 'delete_material_model', { material: 'nope', id: 'x' })).toBe('MAT_RECORD_NOT_FOUND');
    const snapshot = structuredClone(doc);
    execute(doc, 'delete_material_model', { material: 'm', id: 'hyper' });
    expect(doc).toEqual(snapshot);
  });
});
