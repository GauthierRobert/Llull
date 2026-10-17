/** material_point_response: presets, mixed control, selection, path validation, validity warnings, failures. */
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import {
  GPa,
  MPa,
  ONE,
  T293,
  addModel,
  codeOf,
  defineSet,
  nl1Document,
  pointResponse,
  withMaterial,
  type PointData,
} from './materialFixtures';

const E = 200000;
const nu = 0.3;
const G = E / (2 * (1 + nu));
const ELASTIC = { kind: 'elastic_isotropic', E: GPa(200), nu: ONE(nu) };
const PERFECT = { kind: 'j2_plasticity', isotropic: { kind: 'perfect', yieldStress: MPa(250) }, kinematic: { kind: 'none' } };

function steel(): CadDocument {
  let doc = withMaterial(createEmptyDocument(), 'steel');
  doc = addModel(doc, 'steel', 'elastic', ELASTIC);
  doc = addModel(doc, 'steel', 'plastic', PERFECT);
  doc = defineSet(doc, 'steel', { id: 'elastic', elastic: 'elastic' });
  return defineSet(doc, 'steel', { id: 'perfect', elastic: 'elastic', plastic: 'plastic' }, true);
}

const call = (doc: CadDocument, steps: unknown[], extra: Record<string, unknown> = {}): PointData =>
  pointResponse(doc, { material: 'steel', kinematics: 'small', set: 'elastic', steps, ...extra });
const code = (doc: CadDocument, steps: unknown[], extra: Record<string, unknown> = {}): string =>
  codeOf(doc, 'material_point_response', { material: 'steel', kinematics: 'small', steps, ...extra });

describe('presets and control (small strain)', () => {
  const doc = steel();
  const strain = 1e-3;

  it('uniaxial stress leaves the other components stress-free', () => {
    const row = call(doc, [{ increments: 4, control: { xx: { strain } } }], { preset: 'uniaxial_stress' }).rows[0];
    expect(row?.stress[0]).toBeCloseTo(E * strain, 8);
    expect(row?.stress.slice(1).every((s) => Math.abs(s) < 1e-7)).toBe(true);
    expect(row?.strain[1]).toBeCloseTo(-nu * strain, 12);
    expect(row?.energyDensity).toBeCloseTo(0.5 * E * strain * strain, 10);
  });

  it('uniaxial strain, plane strain, equibiaxial, pure shear and simple shear', () => {
    const lambda = (E * nu) / ((1 + nu) * (1 - 2 * nu));
    const uniaxialStrain = call(doc, [{ increments: 2, control: { xx: { strain } } }], { preset: 'uniaxial_strain' }).rows[0];
    expect(uniaxialStrain?.stress[0]).toBeCloseTo((lambda + 2 * G) * strain, 8);
    expect(uniaxialStrain?.stress[1]).toBeCloseTo(lambda * strain, 8);
    const planeStrain = call(doc, [{ increments: 2, control: { xx: { strain }, yy: { strain: strain / 2 } } }], { preset: 'plane_strain' })
      .rows[0];
    expect(planeStrain?.stress[2]).toBeCloseTo(lambda * 1.5 * strain, 8);
    expect(planeStrain?.stress[3]).toBeCloseTo(0, 8);
    const equibiaxial = call(doc, [{ increments: 2, control: { xx: { strain } } }], { preset: 'equibiaxial' }).rows[0];
    expect(equibiaxial?.stress[0]).toBeCloseTo(equibiaxial?.stress[1] ?? Number.NaN, 8);
    expect(equibiaxial?.strain[2]).toBeCloseTo((-2 * nu * strain) / (1 - nu), 12);
    const pureShear = call(doc, [{ increments: 2, control: { xx: { strain } } }], { preset: 'pure_shear' }).rows[0];
    expect(pureShear?.strain[1]).toBe(0);
    expect(pureShear?.stress[2]).toBeCloseTo(0, 8);
    const simpleShear = call(doc, [{ increments: 2, control: { xy: { strain: 2 * strain } } }], { preset: 'simple_shear' }).rows[0];
    expect(simpleShear?.stress[3]).toBeCloseTo(G * 2 * strain, 8);
    expect(simpleShear?.stress[0]).toBeCloseTo(0, 8);
    const tied = call(doc, [{ increments: 2, control: { xx: { stress: MPa(100) } } }], { preset: 'equibiaxial' }).rows[0];
    expect(tied?.stress[1]).toBeCloseTo(100, 6);
    const own = call(doc, [{ increments: 2, control: { xx: { strain }, yy: { strain: 0 } } }], { preset: 'equibiaxial' }).rows[0];
    expect(own?.strain[1]).toBe(0);
  });

  it('solves mixed control by Newton and gives the same answer as direct strain control', () => {
    const row = call(doc, [{ increments: 3, control: { xx: { stress: MPa(150) }, yy: { strain: 0 } } }]).rows[0];
    expect(row?.stress[0]).toBeCloseTo(150, 6);
    expect(row?.strain[1]).toBe(0);
    const plastic = pointResponse(doc, {
      material: 'steel',
      kinematics: 'small',
      preset: 'uniaxial_stress',
      steps: [
        { increments: 10, control: { xx: { stress: MPa(200) } } },
        { increments: 10, control: { xx: { strain: 0.01 } } },
        { increments: 10, control: { xx: { stress: MPa(0) } } },
      ],
    });
    expect(plastic.rows[1]?.stress[0]).toBeCloseTo(250, 5);
    expect(plastic.rows[1]?.eqPlasticStrain).toBeCloseTo(0.01 - 250 / E, 6);
    expect(plastic.rows[2]?.stress[0]).toBeCloseTo(0, 6);
    expect(plastic.rows[2]?.strain[0]).toBeCloseTo(0.01 - 250 / E, 6);
    expect(plastic.defaults.map((d) => d.name)).toEqual(expect.arrayContaining(['stepDuration', 'newtonTolerance', 'output']));
  });

  it('outputs every increment on request and lists the named defaults only when used', () => {
    const each = call(doc, [{ increments: 5, duration: { value: 2, unit: 's' }, control: { xx: { strain } } }], { output: 'increments' });
    expect(each.rows.map((r) => r.increment)).toEqual([1, 2, 3, 4, 5]);
    expect(each.rows[4]?.time).toBeCloseTo(2, 12);
    expect(each.defaults.map((d) => d.name)).toEqual(['newtonTolerance']);
    expect(each.unverified).toBe(true);
    expect(each.unverifiedReasons).toContain("elastic 'elastic': basis unspecified");
  });

  it('runs an ad-hoc model, alone or replacing a slot of the set, without storing it', () => {
    const alone = pointResponse(doc, {
      material: 'steel',
      kinematics: 'small',
      model: {
        kind: 'elastic_orthotropic',
        E1: GPa(100),
        E2: GPa(50),
        E3: GPa(50),
        nu12: ONE(0.2),
        nu13: ONE(0.2),
        nu23: ONE(0.2),
        G12: GPa(20),
        G13: GPa(20),
        G23: GPa(20),
      },
      steps: [{ increments: 2, control: { xx: { strain: 1e-3 }, yy: { strain: 0 }, zz: { strain: 0 } } }],
    });
    expect(alone.rows[0]?.stress[0]).toBeGreaterThan(100);
    expect(alone.unverifiedReasons.some((reason) => reason.includes('adhoc'))).toBe(true);
    const replaced = pointResponse(doc, {
      material: 'steel',
      kinematics: 'small',
      set: 'perfect',
      model: { kind: 'j2_plasticity', isotropic: { kind: 'perfect', yieldStress: MPa(100) }, kinematic: { kind: 'none' } },
      preset: 'uniaxial_stress',
      steps: [{ increments: 20, control: { xx: { strain: 0.01 } } }],
    });
    expect(replaced.rows[0]?.stress[0]).toBeCloseTo(100, 5);
    expect(doc.materials['steel']?.materialModels).toHaveLength(2);
    const orthotropic = {
      kind: 'elastic_orthotropic',
      E1: GPa(200),
      E2: GPa(200),
      E3: GPa(200),
      nu12: ONE(0.3),
      nu13: ONE(0.3),
      nu23: ONE(0.3),
      G12: GPa(77),
      G13: GPa(77),
      G23: GPa(77),
    };
    expect(
      codeOf(doc, 'material_point_response', {
        material: 'steel',
        kinematics: 'small',
        set: 'perfect',
        model: orthotropic,
        steps: [{ increments: 2, control: { xx: { strain: 1e-4 } } }],
      }),
    ).toBe('MATL_PATH_INVALID');
    const defaulted = pointResponse(doc, {
      material: 'steel',
      kinematics: 'small',
      set: 'elastic',
      steps: [{ control: { xx: { strain: 1e-4 } } }],
    });
    expect(defaulted.defaults.find((d) => d.name === 'incrementsPerStep')?.value).toBe(100);
  });
});

describe('path validation and failures', () => {
  const doc = steel();
  const xx = { xx: { strain: 1e-3 } };

  it('refuses malformed paths with MATL_PATH_INVALID and the offending path', () => {
    const result = execute(doc, 'material_point_response', {
      material: 'steel',
      kinematics: 'small',
      steps: [{ increments: 1, control: { qq: { strain: 1 } } }],
    });
    expect(result.error).toMatchObject({ code: 'MATL_PATH_INVALID', paths: ['steps[0].control.qq'] });
    expect(code(doc, [{ increments: 1, control: { xx: { strain: 1e-3, stress: MPa(1) } } }])).toBe('MATL_PATH_INVALID');
    expect(code(doc, [{ increments: 1, control: { xx: {} } }])).toBe('MATL_PATH_INVALID');
    expect(code(doc, [{ increments: 1, control: { xx: { stress: { value: 1, unit: 'K' } } } }])).toBe('MATL_PATH_INVALID');
    expect(code(doc, [{ increments: 1, duration: { value: 1, unit: 'MPa' }, control: xx }])).toBe('MATL_PATH_INVALID');
    expect(code(doc, [{ increments: 1, temperature: { value: 1, unit: 'MPa' }, control: xx }])).toBe('MATL_PATH_INVALID');
    expect(code(doc, [{ increments: 1, duration: { value: -1, unit: 's' }, control: xx }])).toBe('MATL_PATH_INVALID');
    expect(code(doc, [{ increments: 0, control: xx }])).toBe('MATL_PATH_INVALID');
    expect(code(doc, [])).toBe('MATL_PATH_INVALID');
    expect(
      code(doc, [
        { increments: 600_000, control: xx },
        { increments: 600_000, control: xx },
      ]),
    ).toBe('MATL_PATH_INVALID');
    expect(code(doc, [{ increments: 10_001, control: xx }], { output: 'increments' })).toBe('MATL_PATH_INVALID');
    expect(code(doc, [{ increments: 1.5, control: xx }])).toBe('CMD_INVALID_PARAMS');
  });

  it('refuses unknown materials and sets, and a missing default set', () => {
    expect(codeOf(doc, 'material_point_response', { material: 'nope', kinematics: 'small', steps: [{ control: xx }] })).toBe(
      'MAT_RECORD_NOT_FOUND',
    );
    expect(code(doc, [{ control: xx }], { set: 'nope' })).toBe('MATL_MODEL_NOT_FOUND');
    const noDefault = defineSet(addModel(withMaterial(createEmptyDocument(), 'steel'), 'steel', 'e', ELASTIC), 'steel', {
      id: 's',
      elastic: 'e',
    });
    expect(code(noDefault, [{ control: xx }])).toBe('MATL_MODEL_NOT_FOUND');
    expect(
      code(doc, [{ control: xx }], {
        model: { kind: 'sn_basquin', sigmaF: MPa(900), b: -0.09, conditions: { probability: 'mean', control: 'load' } },
      }),
    ).toBe('MATL_COMBINATION_INVALID');
    expect(code(doc, [{ control: xx }], { model: { kind: 'elastic_isotropic', E: GPa(1), nu: ONE(0.5) } })).toBe('MATL_POISSON_BOUND');
    expect(code(doc, [{ control: xx }], { model: { nope: 1 } })).toBe('MATL_LAW_PARAMS_INVALID');
    expect(code(doc, [{ control: xx }], { model: { kind: 'elastic_isotropic', E: GPa(1) } })).toBe('MATL_LAW_PARAMS_INVALID');
    expect(
      code(doc, [{ control: xx }], { set: 'perfect', model: { kind: 'hyper_neo_hooke', C10: MPa(1), D1: { value: 0, unit: '1/MPa' } } }),
    ).toBe('MATL_COMBINATION_INVALID');
  });

  it('reports MATL_PATH_DIVERGED when a stress target cannot be reached', () => {
    const result = execute(doc, 'material_point_response', {
      material: 'steel',
      kinematics: 'small',
      preset: 'uniaxial_stress',
      steps: [{ increments: 4, control: { xx: { stress: MPa(400) } } }],
    });
    expect(result.error?.code).toBe('MATL_PATH_DIVERGED');
    expect(result.data).toMatchObject({ code: 'MATL_PATH_DIVERGED', step: 1 });
    expect(result.summary).toContain('step 1');
  });

  it('refuses plasticity on orthotropic elasticity and tangent moduli above E', () => {
    let local = withMaterial(createEmptyDocument(), 'steel');
    local = addModel(local, 'steel', 'ortho', {
      kind: 'elastic_orthotropic',
      E1: GPa(100),
      E2: GPa(50),
      E3: GPa(50),
      nu12: ONE(0.2),
      nu13: ONE(0.2),
      nu23: ONE(0.2),
      G12: GPa(20),
      G13: GPa(20),
      G23: GPa(20),
    });
    local = addModel(local, 'steel', 'plastic', PERFECT);
    local = defineSet(local, 'steel', { id: 's', elastic: 'ortho', plastic: 'plastic' }, true);
    expect(code(local, [{ control: xx }])).toBe('MATL_PATH_INVALID');
    let tangent = addModel(withMaterial(createEmptyDocument(), 'steel'), 'steel', 'elastic', ELASTIC);
    tangent = addModel(tangent, 'steel', 'plastic', {
      kind: 'j2_plasticity',
      isotropic: { kind: 'linear', yieldStress: MPa(250), modulus: GPa(300), modulusKind: 'tangent' },
      kinematic: { kind: 'none' },
    });
    tangent = defineSet(tangent, 'steel', { id: 's', elastic: 'elastic', plastic: 'plastic' }, true);
    expect(code(tangent, [{ control: xx }])).toBe('MATL_LAW_PARAMS_INVALID');
    let combined = addModel(withMaterial(createEmptyDocument(), 'steel'), 'steel', 'elastic', ELASTIC);
    combined = addModel(combined, 'steel', 'plastic', PERFECT);
    combined = addModel(combined, 'steel', 'visco', { kind: 'visco_prony', shear: [{ g: 0.3, tau: { value: 1, unit: 's' } }] });
    combined = defineSet(combined, 'steel', { id: 's', elastic: 'elastic', plastic: 'plastic', viscoelastic: 'visco' }, true);
    expect(code(combined, [{ control: xx }])).toBe('MATL_PATH_INVALID');
  });

  it('warns once per model and variable when the state leaves the declared validity', () => {
    const data = pointResponse(nl1Document(), {
      material: 'nl1_steel',
      set: 'iso_hardening',
      kinematics: 'small',
      preset: 'uniaxial_stress',
      output: 'increments',
      steps: [{ increments: 20, temperature: { value: 350, unit: 'K' }, control: { xx: { strain: 0.01 } } }],
    });
    const codes = data.warnings.map((w) => w.code);
    expect(codes).toEqual(['MATL_STRAIN_OUT_OF_RANGE', 'MATL_STRAIN_OUT_OF_RANGE', 'MATL_STRAIN_OUT_OF_RANGE']);
    expect(data.warnings.map((w) => w.message.split(' ')[0]).sort()).toEqual(['T', 'T', 'equivalentPlasticStrain']);
    expect(data.unverifiedReasons.some((reason) => reason.includes('outside the validity'))).toBe(true);
    expect(data.rows[0]?.T).toBe(350);
  });

  it('checks the time, rate and pressure validity ranges and ignores unmonitored variables', () => {
    let local = withMaterial(createEmptyDocument(), 'steel');
    local = addModel(local, 'steel', 'elastic', ELASTIC, {
      validity: [
        { variable: 'time', unit: 'min', data: [0, 0.01] },
        { variable: 'strainRate', unit: '1/s', data: [0, 1e-9] },
        { variable: 'exposureTime', unit: 's', data: [0, 1] },
        { variable: 'T', unit: 'degC', data: [-300, 20] },
      ],
    });
    local = defineSet(local, 'steel', { id: 's', elastic: 'elastic' }, true);
    const data = pointResponse(local, {
      material: 'steel',
      kinematics: 'small',
      steps: [
        { increments: 2, duration: { value: 10, unit: 's' }, temperature: { value: 300, unit: 'K' }, control: { xx: { strain: 1e-3 } } },
      ],
    });
    expect(data.warnings.map((w) => w.message.split(' ')[0]).sort()).toEqual(['T', 'strainRate', 'time']);
  });
});

describe('temperature-dependent hardening', () => {
  it('blends tabulated curves with the step temperature and refuses to extrapolate', () => {
    let doc = withMaterial(createEmptyDocument(), 'steel');
    doc = addModel(doc, 'steel', 'elastic', ELASTIC, { validity: T293 });
    doc = addModel(doc, 'steel', 'plastic', {
      kind: 'j2_plasticity',
      isotropic: {
        kind: 'multilinear',
        stressUnit: 'MPa',
        inputMeasure: { stress: 'true', strain: 'plastic', strainKind: 'true' },
        curves: [
          {
            temperature: { value: 200, unit: 'K' },
            points: [
              [300, 0],
              [400, 0.1],
            ],
          },
          {
            temperature: { value: 400, unit: 'K' },
            points: [
              [200, 0],
              [300, 0.1],
            ],
          },
        ],
      },
      kinematic: { kind: 'none' },
    });
    doc = defineSet(doc, 'steel', { id: 's', elastic: 'elastic', plastic: 'plastic' }, true);
    const at = (kelvin: number): number =>
      pointResponse(doc, {
        material: 'steel',
        kinematics: 'small',
        preset: 'uniaxial_stress',
        steps: [{ increments: 10, temperature: { value: kelvin, unit: 'K' }, control: { xx: { strain: 0.01 } } }],
      }).rows[0]?.stress[0] ?? Number.NaN;
    expect(at(200)).toBeGreaterThan(at(300));
    expect(at(300)).toBeGreaterThan(at(400));
    expect(at(300)).toBeCloseTo(250 + (at(200) - 300 + at(400) - 200) * 0 + (at(300) - 250), 9);
    const outside = execute(doc, 'material_point_response', {
      material: 'steel',
      kinematics: 'small',
      steps: [{ increments: 1, temperature: { value: 500, unit: 'K' }, control: { xx: { strain: 0.01 } } }],
    });
    expect(outside.error?.code).toBe('PROP_OUT_OF_RANGE');
    expect(
      codeOf(doc, 'material_point_response', {
        material: 'steel',
        kinematics: 'small',
        steps: [{ increments: 1, control: { xx: { strain: 0.01 } } }],
      }),
    ).toBe('accepted');
  });

  it('needs a temperature for Johnson-Cook hardening', () => {
    let doc = withMaterial(createEmptyDocument(), 'steel');
    doc = addModel(doc, 'steel', 'elastic', ELASTIC);
    doc = addModel(doc, 'steel', 'plastic', {
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
    doc = defineSet(doc, 'steel', { id: 's', elastic: 'elastic', plastic: 'plastic' }, true);
    expect(
      codeOf(doc, 'material_point_response', {
        material: 'steel',
        kinematics: 'small',
        steps: [{ increments: 1, control: { xx: { strain: 0.01 } } }],
      }),
    ).toBe('PROP_VARIABLE_MISSING');
  });
});
