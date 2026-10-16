/** VC-MATL-15 (wrong inputs) and VC-MATL-16 (durability variants). */
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { expectCase } from '../benchmarkCases';
import { GPa, MPa, NL1_ELASTIC, ONE, PACK, SOURCE, addModel, codeOf, defineSet, run, withMaterial } from './materialFixtures';

const add = (doc: CadDocument, model: Record<string, unknown>, extra: Record<string, unknown> = {}): string =>
  codeOf(doc, 'add_material_model', { material: 'steel', id: 'm', model, basis: 'typical', source: SOURCE, ...extra });

describe('VC-MATL-15 and 16', () => {
  it('reports every wrong input of the validation pack with its code', () => {
    const doc = withMaterial(createEmptyDocument(), 'steel');
    const codes = [
      add(doc, {
        kind: 'j2_plasticity',
        isotropic: { kind: 'linear', yieldStress: MPa(5), modulus: GPa(62.5) },
        kinematic: { kind: 'none' },
      }),
      add(doc, {
        kind: 'j2_plasticity',
        isotropic: {
          kind: 'multilinear',
          stressUnit: 'MPa',
          curves: [
            {
              points: [
                [5, 0],
                [6, 0.1],
              ],
            },
          ],
        },
        kinematic: { kind: 'none' },
      }),
      add(doc, { kind: 'elastic_isotropic', E: GPa(70), nu: ONE(0.5) }),
      add(doc, {
        kind: 'elastic_orthotropic',
        E1: MPa(135000),
        E2: MPa(10000),
        E3: MPa(10000),
        nu12: ONE(3.8),
        nu13: ONE(0.3),
        nu23: ONE(0.45),
        G12: MPa(5000),
        G13: MPa(5000),
        G23: MPa(3448),
      }),
      add(doc, {
        kind: 'visco_prony',
        shear: [
          { g: 0.6, tau: { value: 1, unit: 's' } },
          { g: 0.5, tau: { value: 2, unit: 's' } },
        ],
      }),
    ];
    expect(codes).toEqual([
      'MATL_HARDENING_MODULUS_KIND_MISSING',
      'MATL_CURVE_MEASURE_MISSING',
      'MATL_POISSON_BOUND',
      'MATL_ELASTIC_NOT_POSITIVE_DEFINITE',
      'MATL_PRONY_INVALID',
    ]);
    expectCase(PACK, 'VC-MATL-03/isoBound/nu=0.5', codes[2] ?? '');
  });

  it('refuses elastic + ramberg_osgood in one set', () => {
    let doc = withMaterial(createEmptyDocument(), 'steel');
    doc = addModel(doc, 'steel', 'e', NL1_ELASTIC);
    doc = addModel(doc, 'steel', 'ro', {
      kind: 'ramberg_osgood',
      form: 'calculix',
      E: GPa(72),
      nu: ONE(0.33),
      sigma0: MPa(400),
      n: 15,
      alpha: 0.36,
    });
    expect(codeOf(doc, 'define_constitutive_set', { material: 'steel', set: { id: 's', elastic: 'e', plastic: 'ro' } })).toBe(
      'MATL_COMBINATION_INVALID',
    );
  });

  it('refuses certification use of an unreviewed fitted model with MAT_VALUE_UNVERIFIED and reviewRequired', () => {
    const fit = {
      method: 'linear_least_squares',
      objective: 'absolute',
      points: 5,
      datasetSha256: 'a'.repeat(64),
      residual: { rms: 0.1, maxAbs: 0.2, maxRel: 0.3, unit: 'MPa' },
      fittedRange: [{ variable: 'stretch', unit: '1', data: [1, 4] }],
      tool: 'test',
    };
    let doc = withMaterial(createEmptyDocument(), 'rubber');
    doc = addModel(doc, 'rubber', 'h', { kind: 'hyper_neo_hooke', C10: MPa(0.2), D1: { value: 0, unit: '1/MPa' } }, { basis: 'A', fit });
    doc = defineSet(doc, 'rubber', { id: 's', hyperelastic: 'h' }, true);
    const steps = [{ increments: 2, control: { xx: { strain: 1 } } }];
    const point = execute(doc, 'material_point_response', { material: 'rubber', kinematics: 'finite', steps, forCertification: true });
    expect(point.error?.code).toBe('MAT_VALUE_UNVERIFIED');
    expect(point.data).toMatchObject({ reviewRequired: true });
    const open = run(doc, 'material_point_response', { material: 'rubber', kinematics: 'finite', steps });
    expect(open.data).toMatchObject({ reviewRequired: true, unverified: true });
    expect((open.data as { unverifiedReasons: string[] }).unverifiedReasons).toEqual(
      expect.arrayContaining(["hyperelastic 'h': fit without data provenance", "hyperelastic 'h': fit not reviewed"]),
    );
    const withValidity = addModel(
      doc,
      'rubber',
      'h',
      { kind: 'hyper_neo_hooke', C10: MPa(0.2), D1: { value: 0, unit: '1/MPa' } },
      { basis: 'A', fit, replace: true, validity: [{ variable: 'stretch', unit: '1', data: [1, 4] }] },
    );
    const exported = execute(withValidity, 'export_material_cards', { material: 'rubber', target: 'calculix', forCertification: true });
    expect(exported.error?.code).toBe('MAT_VALUE_UNVERIFIED');
    expect(run(withValidity, 'export_material_cards', { material: 'rubber', target: 'calculix' }).data).toMatchObject({
      reviewRequired: true,
    });
  });

  it('accepts every PHY-07 / PHY-08 durability variant, validates it and keeps it out of sets (VC-MATL-16)', () => {
    const conditions = { probability: 'mean', control: 'load' };
    const crack = { stressRatio: 0.1 };
    const variants: Record<string, unknown>[] = [
      { kind: 'sn_basquin', sigmaF: MPa(900), b: -0.09, conditions },
      { kind: 'sn_power_law', k: 5, nD: 1e7, sD: MPa(100), k2: 'cutoff', conditions },
      {
        kind: 'sn_table',
        families: [
          {
            stressRatio: -1,
            points: [
              [1e4, 400],
              [1e6, 200],
            ],
            amplitudeUnit: 'MPa',
          },
        ],
        measure: 'amplitude',
        conditions,
      },
      { kind: 'sn_equivalent_stress', a1: 1, a2: 2, a3: 3, a4: 4, unit: 'MPa', conditions },
      {
        kind: 'en_coffin_manson',
        sigmaF: MPa(900),
        b: -0.09,
        epsF: 0.5,
        c: -0.6,
        E: GPa(70),
        conditions: { ...conditions, control: 'strain' },
      },
      { kind: 'cyclic_ramberg_osgood', Kprime: MPa(1000), nPrime: 0.1, E: GPa(70) },
      {
        kind: 'haigh_table',
        lifeCycles: 1e7,
        points: [
          [0, 100],
          [200, 50],
        ],
        unit: 'MPa',
      },
      { kind: 'da_dn_paris', C: 1e-11, m: 3, units: 'm/cycle|MPa*m^0.5', conditions: crack },
      {
        kind: 'da_dn_walker',
        C: 1e-11,
        m: 3,
        gamma: 0.5,
        convention: 'dK_over_(1-R)^(1-gamma)',
        units: 'm/cycle|MPa*m^0.5',
        conditions: crack,
      },
      { kind: 'da_dn_forman', C: 1e-11, n: 3, Kc: 40, units: 'm/cycle|MPa*m^0.5', conditions: crack },
      {
        kind: 'da_dn_nasgro',
        C: 1e-11,
        n: 3,
        p: 0.5,
        q: 1,
        threshold: { dK0: 2 },
        toughness: { Kc: 40 },
        closure: { kind: 'newman', alpha: 2, smaxOverSigma0: 0.3 },
        units: 'm/cycle|MPa*m^0.5',
        conditions: crack,
      },
      {
        kind: 'da_dn_table',
        families: [
          {
            stressRatio: 0.1,
            points: [
              [5, 1e-9],
              [20, 1e-7],
            ],
          },
        ],
        interpolation: 'log_log',
        units: 'm/cycle|MPa*m^0.5',
        conditions: crack,
      },
      { kind: 'fracture_toughness', KIc: { value: 30, unit: 'MPa*m^0.5' }, state: 'plane_strain', orientation: 'L-T' },
    ];
    let doc = withMaterial(createEmptyDocument(), 'al');
    for (const [i, variant] of variants.entries()) {
      doc = addModel(doc, 'al', `d${i}`, variant);
      expect(doc.materials['al']?.materialModels?.[i]?.model.kind).toBe(variant['kind']);
    }
    doc = addModel(doc, 'al', 'e', NL1_ELASTIC);
    expect(codeOf(doc, 'define_constitutive_set', { material: 'al', set: { id: 's', elastic: 'e', plastic: 'd0' } })).toBe(
      'MATL_COMBINATION_INVALID',
    );
    expect(codeOf(doc, 'define_constitutive_set', { material: 'al', set: { id: 's', elastic: 'd5' } })).toBe('MATL_COMBINATION_INVALID');
    const bad = (model: Record<string, unknown>): string =>
      codeOf(doc, 'add_material_model', { material: 'al', id: 'bad', model, basis: 'A', source: SOURCE });
    expect(bad({ kind: 'sn_basquin', sigmaF: MPa(-1), b: -0.09, conditions })).toBe('MATL_LAW_PARAMS_INVALID');
    expect(bad({ kind: 'sn_basquin', sigmaF: { value: 1, unit: 'nonsense' }, b: -0.09, conditions })).toBe('MATL_LAW_PARAMS_INVALID');
    expect(bad({ kind: 'sn_basquin', sigmaF: MPa(900), b: -0.09 })).toBe('MATL_LAW_PARAMS_INVALID');
    expect(bad({ kind: 'sn_table', families: [], measure: 'amplitude', conditions })).toBe('MATL_LAW_PARAMS_INVALID');
    expect(bad({ kind: 'sn_table', families: [{ points: [[1, 1]], amplitudeUnit: 'MPa' }], measure: 'max', conditions })).toBe(
      'MATL_LAW_PARAMS_INVALID',
    );
    expect(bad({ kind: 'da_dn_paris', C: 0, m: 3, units: 'm/cycle|MPa*m^0.5', conditions: crack })).toBe('MATL_LAW_PARAMS_INVALID');
    expect(bad({ kind: 'da_dn_forman', C: 1, n: 3, Kc: 0, units: 'x', conditions: crack })).toBe('MATL_LAW_PARAMS_INVALID');
    expect(bad({ kind: 'fracture_toughness', state: 'plane_strain' })).toBe('MATL_LAW_PARAMS_INVALID');
    expect(bad({ kind: 'haigh_table', lifeCycles: 1e7, points: [[0, 1]], unit: 'MPa' })).toBe('MATL_LAW_PARAMS_INVALID');
    expect(bad({ kind: 'sn_power_law', k: 5, nD: 1e7, sD: { value: 1, unit: 'K' }, conditions })).toBe('MATL_LAW_PARAMS_INVALID');
    expect(bad({ kind: 'en_coffin_manson', sigmaF: MPa(1), b: -0.1, epsF: 0, c: -0.6, E: GPa(70), conditions })).toBe(
      'MATL_LAW_PARAMS_INVALID',
    );
    expect(bad({ kind: 'cyclic_ramberg_osgood', Kprime: MPa(1000), nPrime: 0, E: GPa(70) })).toBe('MATL_LAW_PARAMS_INVALID');
    expect(bad({ kind: 'sn_equivalent_stress', a1: 1, a2: 2, a3: 3, a4: 4, unit: 'MPa', conditions })).toBe('accepted');
    expect(
      bad({
        kind: 'da_dn_nasgro',
        C: 0,
        n: 3,
        p: 1,
        q: 1,
        threshold: { dKth: 1 },
        toughness: { Kc: 1 },
        closure: { kind: 'none' },
        units: 'x',
        conditions: crack,
      }),
    ).toBe('MATL_LAW_PARAMS_INVALID');
    expect(
      bad({
        kind: 'da_dn_table',
        families: [
          {
            stressRatio: 0.1,
            points: [
              [0, 1],
              [2, 1],
            ],
          },
        ],
        interpolation: 'log_log',
        units: 'x',
        conditions: crack,
      }),
    ).toBe('MATL_LAW_PARAMS_INVALID');
    const warning = run(doc, 'check_material_models', {});
    expect((warning.data as { unverified: unknown[] }).unverified.length).toBeGreaterThan(10);
  });
});
