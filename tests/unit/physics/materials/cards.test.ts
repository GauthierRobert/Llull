/** VC-MATL-13, 14: CalculiX and Nastran material cards (exact text), export refusals and warnings. */
import { describe, expect, it } from 'vitest';
import { calculixNumber, nastranReal } from '@core/model/materialLaws/cardFormat';
import { execute } from '@core/commands/registry';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { expectCase } from '../benchmarkCases';
import {
  GPa,
  MPa,
  ONE,
  PACK,
  NL1_ELASTIC,
  NL1_HARDENING,
  NL1_PERFECT,
  NL1_VALIDITY,
  T293,
  addModel,
  codeOf,
  defineSet,
  nl1Document,
  run,
  withMaterial,
} from './materialFixtures';

interface Cards {
  lines: string[];
  header: string;
  name: string;
  unverified: boolean;
  unverifiedReasons: string[];
  reviewRequired: boolean;
  warnings: { code: string }[];
  defaults: { name: string }[];
}
const cards = (doc: CadDocument, params: Record<string, unknown>): Cards => run(doc, 'export_material_cards', params).data as Cards;

const single = (material: string, models: Record<string, Record<string, unknown>>, set: Record<string, unknown>): CadDocument => {
  let doc = withMaterial(createEmptyDocument(), material);
  for (const [id, model] of Object.entries(models)) doc = addModel(doc, material, id, model, { validity: T293 });
  return defineSet(doc, material, set, true);
};

describe('CalculiX cards (VC-MATL-13)', () => {
  it('writes the Ramberg-Osgood card without *ELASTIC', () => {
    const doc = single(
      'al_ro',
      { ro: { kind: 'ramberg_osgood', form: 'engineering', E: GPa(72), nu: ONE(0.33), sigma02: MPa(400), n: 15 } },
      { id: 's', plastic: 'ro' },
    );
    expectCase(PACK, 'VC-MATL-13/ccx/rambergOsgood', cards(doc, { material: 'al_ro', target: 'calculix', name: 'AL_RO' }).lines);
  });

  it('writes engineering constants with the temperature column', () => {
    const doc = single(
      'cfrp_ud',
      {
        e: {
          kind: 'elastic_orthotropic',
          E1: MPa(135000),
          E2: MPa(10000),
          E3: MPa(10000),
          nu12: ONE(0.3),
          nu13: ONE(0.3),
          nu23: ONE(0.45),
          G12: MPa(5000),
          G13: MPa(5000),
          G23: MPa(3448),
        },
      },
      { id: 's', elastic: 'e' },
    );
    const lines = cards(doc, { material: 'cfrp_ud', target: 'calculix', name: 'CFRP_UD', temperatures: [{ value: 293, unit: 'K' }] }).lines;
    expectCase(PACK, 'VC-MATL-13/ccx/engineeringConstants', lines);
  });

  it('tabulates linear isotropic hardening up to the declared plastic-strain validity', () => {
    const data = cards(nl1Document(), { material: 'nl1_steel', set: 'iso_hardening', target: 'calculix', name: 'NL1_ISO' });
    expectCase(PACK, 'VC-MATL-13/ccx/plasticLinearIsotropic', data.lines);
    expect(data.defaults.map((d) => d.name)).toContain('linearLawExtension');
    expect(data.unverified).toBe(true);
    expect(data.header).toMatch(
      /^\*\* llull material nl1_steel\/iso_hardening sha256=[0-9a-f]{64} unverified=elastic 'elastic': basis unspecified/,
    );
    expect(cards(nl1Document(), { material: 'nl1_steel', set: 'perfect', target: 'calculix' }).lines).toEqual([
      '*MATERIAL,NAME=NL1_STEEL_PERFECT',
      '*ELASTIC',
      '250000.,0.25',
      '*PLASTIC,HARDENING=ISOTROPIC',
      '5.,0.',
    ]);
  });

  it('writes Ogden N = 3 in the canonical convention and warns about D = 0', () => {
    const doc = single(
      'ogden',
      {
        og: {
          kind: 'hyper_ogden',
          convention: 'ogden1972',
          terms: [
            { mu: 0.63, alpha: 1.3 },
            { mu: 0.0012, alpha: 5 },
            { mu: -0.01, alpha: -2 },
          ],
          D: [0, 0, 0],
          stressUnit: 'MPa',
        },
      },
      { id: 's', hyperelastic: 'og' },
    );
    const data = cards(doc, { material: 'ogden', target: 'calculix', name: 'TRELOAR_OGDEN' });
    expectCase(PACK, 'VC-MATL-13/ccx/ogdenN3', data.lines);
    expect(data.warnings.map((w) => w.code)).toEqual(['MATL_INCOMPRESSIBLE_DEFAULT']);
  });

  it('writes Norton creep after the elastic card', () => {
    const doc = single(
      'creep_n5',
      {
        e: { kind: 'elastic_isotropic', E: MPa(200000), nu: ONE(0.3) },
        c: { kind: 'creep_norton', A: 1e-10, n: 5, m: 0, stressUnit: 'MPa', timeUnit: 'h', hardening: 'time' },
      },
      { id: 's', elastic: 'e', creep: 'c' },
    );
    expectCase(
      PACK,
      'VC-MATL-13/ccx/norton',
      cards(doc, { material: 'creep_n5', target: 'calculix', name: 'CREEP_N5', temperatures: [{ value: 100, unit: 'K' }] }).lines,
    );
    const gpa = single(
      'creep_gpa',
      {
        e: { kind: 'elastic_isotropic', E: MPa(200000), nu: ONE(0.3) },
        c: { kind: 'creep_norton', A: 1e-10, n: 2, m: 0, stressUnit: 'GPa', timeUnit: 'h', hardening: 'time' },
      },
      { id: 's', elastic: 'e', creep: 'c' },
    );
    expect(cards(gpa, { material: 'creep_gpa', target: 'calculix' }).lines[4]).toBe('1e-16,2.,0.');
  });

  it('writes anisotropic, transversely isotropic and every hyperelastic card', () => {
    const upper = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21].map((v) =>
      v === 1 ? 500000 : v <= 6 ? 0 : v === 7 ? 400000 : 0,
    );
    void upper;
    const stiffness = [500000, 157200, 157200, 0, 0, 0, 400000, 157200, 0, 0, 0, 300000, 0, 0, 0, 126200, 0, 0, 126200, 0, 126200];
    const aniso = single('an', { a: { kind: 'elastic_anisotropic', stiffness, unit: 'MPa' } }, { id: 's', elastic: 'a' });
    expect(cards(aniso, { material: 'an', target: 'calculix', temperatures: [{ value: 20, unit: 'degC' }] }).lines).toEqual([
      '*MATERIAL,NAME=AN_S',
      '*ELASTIC,TYPE=ANISO',
      '500000.,157200.,400000.,157200.,157200.,300000.,0.,0.',
      '0.,126200.,0.,0.,0.,0.,126200.,0.',
      '0.,0.,0.,0.,126200.,293.15',
    ]);
    const transverse = single(
      'ti',
      {
        t: {
          kind: 'elastic_transversely_isotropic',
          isotropyPlane: '12',
          Ep: MPa(10000),
          Et: MPa(135000),
          nuP: ONE(0.3),
          nuPT: ONE(0.02),
          Gt: MPa(5000),
        },
      },
      { id: 's', elastic: 't' },
    );
    expect(cards(transverse, { material: 'ti', target: 'calculix' }).lines[1]).toBe('*ELASTIC,TYPE=ENGINEERING CONSTANTS');
    const D = { value: 0.001, unit: '1/MPa' };
    const hyper = (model: Record<string, unknown>): string[] => {
      const doc = single('rubber', { h: model }, { id: 's', hyperelastic: 'h' });
      return cards(doc, { material: 'rubber', target: 'calculix', name: 'R' }).lines.slice(1);
    };
    expect(hyper({ kind: 'hyper_neo_hooke', C10: MPa(0.2), D1: D })).toEqual(['*HYPERELASTIC,NEO HOOKE', '0.2,0.001']);
    expect(hyper({ kind: 'hyper_mooney_rivlin', C10: MPa(0.16), C01: MPa(0.02), D1: D })).toEqual([
      '*HYPERELASTIC,MOONEY-RIVLIN',
      '0.16,0.02,0.001',
    ]);
    expect(
      hyper({ kind: 'hyper_yeoh', C10: MPa(0.18), C20: MPa(-0.002), C30: MPa(0.0001), D: [0.001, 0, 0], compliance: '1/MPa' }),
    ).toEqual(['*HYPERELASTIC,YEOH', '0.18,-0.002,0.0001,0.001,0.,0.']);
    expect(
      hyper({ kind: 'hyper_polynomial', order: 2, C: { C10: 0.2, C01: 0.05, C20: 0.001 }, D: [0.001, 0.002], stressUnit: 'MPa' }),
    ).toEqual(['*HYPERELASTIC,POLYNOMIAL,N=2', '0.2,0.05,0.001,0.,0.,0.001,0.002']);
    expect(hyper({ kind: 'hyper_reduced_polynomial', order: 2, Ci0: [0.2, -0.001], D: [0.001, 0], stressUnit: 'MPa' })).toEqual([
      '*HYPERELASTIC,REDUCED POLYNOMIAL,N=2',
      '0.2,-0.001,0.001,0.',
    ]);
    expect(hyper({ kind: 'hyper_arruda_boyce', mu: MPa(0.27), lambdaM: 2.8, D })).toEqual(['*HYPERELASTIC,ARRUDA-BOYCE', '0.27,2.8,0.001']);
  });

  it('writes kinematic, combined, Johnson-Cook, Voce and multilinear plasticity', () => {
    const plastic = (
      isotropic: Record<string, unknown>,
      kinematic: Record<string, unknown>,
      extra: Record<string, Record<string, unknown>> = {},
      validity = NL1_VALIDITY,
    ): string[] => {
      let doc = withMaterial(createEmptyDocument(), 'm');
      doc = addModel(doc, 'm', 'e', NL1_ELASTIC, { validity: T293 });
      doc = addModel(doc, 'm', 'p', { kind: 'j2_plasticity', isotropic, kinematic }, { validity });
      for (const [id, model] of Object.entries(extra)) doc = addModel(doc, 'm', id, model, { validity: T293 });
      doc = defineSet(doc, 'm', { id: 's', elastic: 'e', plastic: 'p', ...(extra['r'] === undefined ? {} : { rate: 'r' }) }, true);
      return cards(doc, { material: 'm', target: 'calculix', name: 'M', temperatures: [{ value: 293, unit: 'K' }] }).lines.slice(3);
    };
    const linear = { kind: 'linear', yieldStress: MPa(5), modulus: GPa(62.5), modulusKind: 'plastic' };
    expect(plastic({ kind: 'perfect', yieldStress: MPa(5) }, { kind: 'linear', C: GPa(10) })).toEqual([
      '*PLASTIC,HARDENING=KINEMATIC',
      '5.,0.,293.',
      '15.,0.001,293.',
    ]);
    expect(plastic(linear, { kind: 'linear', C: GPa(10) })).toEqual([
      '*PLASTIC,HARDENING=COMBINED',
      '5.,0.,293.',
      '15.,0.001,293.',
      '*CYCLIC HARDENING',
      '5.,0.,293.',
      '67.5,0.001,293.',
    ]);
    const voce = plastic({ kind: 'voce', yieldStress: MPa(5), Q: MPa(10), b: 1000 }, { kind: 'none' });
    expect(voce.length).toBe(22);
    expect(voce[1]).toBe('5.,0.,293.');
    const jc = plastic(
      {
        kind: 'johnson_cook',
        A: MPa(500),
        B: MPa(300),
        n: 0.3,
        m: 1,
        meltTemperature: { value: 1800, unit: 'K' },
        transitionTemperature: { value: 293, unit: 'K' },
      },
      { kind: 'none' },
      { r: { kind: 'rate_johnson_cook', C: 0.015, referenceRate: { value: 1, unit: '1/s' } } },
    );
    expect(jc).toEqual([
      '*PLASTIC,HARDENING=JOHNSON COOK',
      '500.,300.,0.3,1.,1800.,293.,293.',
      '*RATE DEPENDENT,TYPE=JOHNSON COOK',
      '0.015,1.',
    ]);
    const curve = {
      kind: 'multilinear',
      stressUnit: 'MPa',
      inputMeasure: { stress: 'true', strain: 'plastic', strainKind: 'true' },
      curves: [
        {
          temperature: { value: 200, unit: 'K' },
          points: [
            [10, 0],
            [20, 0.1],
          ],
        },
        {
          temperature: { value: 400, unit: 'K' },
          points: [
            [6, 0],
            [12, 0.1],
          ],
        },
      ],
    };
    let doc = withMaterial(createEmptyDocument(), 'm');
    doc = addModel(doc, 'm', 'e', NL1_ELASTIC, { validity: T293 });
    doc = addModel(doc, 'm', 'p', { kind: 'j2_plasticity', isotropic: curve, kinematic: { kind: 'none' } }, { validity: T293 });
    doc = defineSet(doc, 'm', { id: 's', elastic: 'e', plastic: 'p' }, true);
    expect(cards(doc, { material: 'm', target: 'calculix', name: 'M' }).lines.slice(2)).toEqual([
      '250000.,0.25,200.',
      '250000.,0.25,400.',
      '*PLASTIC,HARDENING=ISOTROPIC',
      '10.,0.,200.',
      '20.,0.1,200.',
      '6.,0.,400.',
      '12.,0.1,400.',
    ]);
    expect(cards(doc, { material: 'm', target: 'calculix', name: 'M', temperatures: [{ value: 300, unit: 'K' }] }).lines.slice(3)).toEqual([
      '*PLASTIC,HARDENING=ISOTROPIC',
      '8.,0.,300.',
      '16.,0.1,300.',
    ]);
    expect(codeOf(doc, 'export_material_cards', { material: 'm', target: 'calculix', temperatures: [{ value: 500, unit: 'K' }] })).toBe(
      'PROP_OUT_OF_RANGE',
    );
  });
});

describe('Nastran cards (VC-MATL-14)', () => {
  it('writes MAT1 + MATS1 for the NL1 hardening', () => {
    expectCase(
      PACK,
      'VC-MATL-14/nastran/NL1',
      cards(nl1Document(), { material: 'nl1_steel', set: 'iso_hardening', target: 'nastran' }).lines,
    );
    expect(cards(nl1Document(), { material: 'nl1_steel', set: 'iso_hardening', target: 'nastran' }).header).toMatch(
      /^\$ llull material nl1_steel\/iso_hardening/,
    );
  });

  it('writes perfect plasticity, kinematic hardening and a chosen MID', () => {
    const lines = cards(nl1Document(), { material: 'nl1_steel', set: 'perfect', target: 'nastran', mid: 12 }).lines;
    expect(lines).toEqual(['MAT1    12      250000.         0.25', 'MATS1   12              PLASTIC 0.      1       1       5.']);
    let doc = withMaterial(createEmptyDocument(), 'k');
    doc = addModel(doc, 'k', 'e', NL1_ELASTIC, { validity: T293 });
    doc = addModel(
      doc,
      'k',
      'p',
      { kind: 'j2_plasticity', isotropic: { kind: 'perfect', yieldStress: MPa(5) }, kinematic: { kind: 'linear', C: GPa(10) } },
      { validity: NL1_VALIDITY },
    );
    doc = defineSet(doc, 'k', { id: 's', elastic: 'e', plastic: 'p' }, true);
    expect(cards(doc, { material: 'k', target: 'nastran' }).lines[1]).toBe('MATS1   1               PLASTIC 10000.  1       2       5.');
  });
});

describe('export refusals', () => {
  const refused = (doc: CadDocument, params: Record<string, unknown>): string => codeOf(doc, 'export_material_cards', params);

  it('names the law a target cannot represent (MATL_EXPORT_UNSUPPORTED)', () => {
    const prony = single(
      'visco',
      {
        e: { kind: 'elastic_isotropic', E: MPa(3), nu: ONE(0.3) },
        v: { kind: 'visco_prony', shear: [{ g: 0.3, tau: { value: 1, unit: 's' } }] },
      },
      { id: 's', elastic: 'e', viscoelastic: 'v' },
    );
    const result = execute(prony, 'export_material_cards', { material: 'visco', target: 'calculix' });
    expect(result.rejected).toBe(true);
    expect(result.error?.remediation).toContain('another law or target');
    expect(refused(prony, { material: 'visco', target: 'calculix' })).toBe('MATL_EXPORT_UNSUPPORTED');
    expect(refused(prony, { material: 'visco', target: 'nastran' })).toBe('MATL_EXPORT_UNSUPPORTED');
    const chaboche = single(
      'ch',
      {
        e: NL1_ELASTIC,
        p: {
          kind: 'j2_plasticity',
          isotropic: { kind: 'perfect', yieldStress: MPa(5) },
          kinematic: { kind: 'chaboche', backstresses: [{ C: MPa(100), gamma: 10 }] },
        },
      },
      { id: 's', elastic: 'e', plastic: 'p' },
    );
    expect(refused(chaboche, { material: 'ch', target: 'calculix' })).toBe('MATL_EXPORT_UNSUPPORTED');
    const garofalo = single(
      'g',
      {
        e: NL1_ELASTIC,
        c: {
          kind: 'creep_garofalo',
          A: { value: 1, unit: '1/s' },
          alpha: { value: 0.01, unit: '1/MPa' },
          n: 4,
          activationEnergy: { value: 3e5, unit: 'J/mol' },
        },
      },
      { id: 's', elastic: 'e', creep: 'c' },
    );
    expect(refused(garofalo, { material: 'g', target: 'calculix' })).toBe('MATL_EXPORT_UNSUPPORTED');
    const strain = single(
      'sh',
      { e: NL1_ELASTIC, c: { kind: 'creep_norton', A: 1e-10, n: 5, m: 0, stressUnit: 'MPa', timeUnit: 'h', hardening: 'strain' } },
      { id: 's', elastic: 'e', creep: 'c' },
    );
    expect(refused(strain, { material: 'sh', target: 'calculix' })).toBe('MATL_EXPORT_UNSUPPORTED');
    const cs = single(
      'cs',
      { e: NL1_ELASTIC, p: NL1_PERFECT, r: { kind: 'rate_cowper_symonds', D: { value: 40, unit: '1/s' }, q: 5 } },
      { id: 's', elastic: 'e', plastic: 'p', rate: 'r' },
    );
    expect(refused(cs, { material: 'cs', target: 'calculix' })).toBe('MATL_EXPORT_UNSUPPORTED');
  });

  it('refuses unsupported Nastran laws and several temperatures', () => {
    const ortho = single(
      'o',
      {
        e: {
          kind: 'elastic_orthotropic',
          E1: MPa(1),
          E2: MPa(1),
          E3: MPa(1),
          nu12: ONE(0.1),
          nu13: ONE(0.1),
          nu23: ONE(0.1),
          G12: MPa(1),
          G13: MPa(1),
          G23: MPa(1),
        },
      },
      { id: 's', elastic: 'e' },
    );
    expect(refused(ortho, { material: 'o', target: 'nastran' })).toBe('MATL_EXPORT_UNSUPPORTED');
    expect(
      refused(nl1Document(), {
        material: 'nl1_steel',
        set: 'iso_hardening',
        target: 'nastran',
        temperatures: [
          { value: 1, unit: 'K' },
          { value: 2, unit: 'K' },
        ],
      }),
    ).toBe('MATL_EXPORT_UNSUPPORTED');
    let doc = withMaterial(createEmptyDocument(), 'big');
    doc = addModel(doc, 'big', 'e', { kind: 'elastic_isotropic', E: MPa(123456789.123), nu: ONE(0.3) }, { validity: T293 });
    doc = defineSet(doc, 'big', { id: 's', elastic: 'e' }, true);
    expect(refused(doc, { material: 'big', target: 'nastran' })).toBe('MATL_EXPORT_UNSUPPORTED');
    const hyper = single(
      'h',
      { h: { kind: 'hyper_neo_hooke', C10: MPa(1), D1: { value: 0, unit: '1/MPa' } } },
      { id: 's', hyperelastic: 'h' },
    );
    expect(refused(hyper, { material: 'h', target: 'nastran' })).toBe('MATL_EXPORT_UNSUPPORTED');
    let multilinear = withMaterial(createEmptyDocument(), 'ml');
    multilinear = addModel(multilinear, 'ml', 'e', NL1_ELASTIC, { validity: T293 });
    multilinear = addModel(
      multilinear,
      'ml',
      'p',
      {
        kind: 'j2_plasticity',
        isotropic: {
          kind: 'multilinear',
          stressUnit: 'MPa',
          inputMeasure: { stress: 'true', strain: 'plastic', strainKind: 'true' },
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
      },
      { validity: T293 },
    );
    multilinear = defineSet(multilinear, 'ml', { id: 's', elastic: 'e', plastic: 'p' }, true);
    expect(refused(multilinear, { material: 'ml', target: 'nastran' })).toBe('MATL_EXPORT_UNSUPPORTED');
    expect(cards(multilinear, { material: 'ml', target: 'calculix' }).lines.slice(3)).toEqual([
      '*PLASTIC,HARDENING=ISOTROPIC',
      '5.,0.',
      '6.,0.1',
    ]);
  });

  it('refuses a missing material, set, validity and bad temperature units', () => {
    const doc = nl1Document();
    expect(refused(doc, { material: 'nope', target: 'calculix' })).toBe('MAT_RECORD_NOT_FOUND');
    expect(refused(doc, { material: 'nl1_steel', set: 'nope', target: 'calculix' })).toBe('MATL_MODEL_NOT_FOUND');
    expect(refused(doc, { material: 'nl1_steel', target: 'calculix', temperatures: [{ value: 1, unit: 'MPa' }] })).toBe(
      'MATL_LAW_PARAMS_INVALID',
    );
    const noValidity = defineSet(
      addModel(withMaterial(createEmptyDocument(), 'x'), 'x', 'e', NL1_ELASTIC),
      'x',
      { id: 's', elastic: 'e' },
      true,
    );
    expect(refused(noValidity, { material: 'x', target: 'calculix' })).toBe('MATL_VALIDITY_MISSING');
    const noLimit = single('y', { e: NL1_ELASTIC, p: NL1_HARDENING }, { id: 's', elastic: 'e', plastic: 'p' });
    expect(refused(noLimit, { material: 'y', target: 'calculix' })).toBe('MATL_VALIDITY_MISSING');
    expect(refused(createEmptyDocument(), { material: 'y', target: 'calculix' })).toBe('MAT_RECORD_NOT_FOUND');
  });

  it('is pure and reports review for fitted models', () => {
    const doc = nl1Document();
    const snapshot = structuredClone(doc);
    const result = run(doc, 'export_material_cards', { material: 'nl1_steel', target: 'calculix' });
    expect(doc).toEqual(snapshot);
    expect(result.document).toBe(doc);
    expect(result.affected).toEqual([]);
    expect(result.summary).toContain("export_material_cards 'nl1_steel/iso_hardening' for calculix");
  });
});

describe('number formatting (§6.3)', () => {
  it('writes the shortest round-trip decimal with a trailing point on integers', () => {
    expect(calculixNumber(72000)).toBe('72000.');
    expect(calculixNumber(0.33)).toBe('0.33');
    expect(calculixNumber(-2)).toBe('-2.');
    expect(calculixNumber(0)).toBe('0.');
    expect(calculixNumber(-0)).toBe('0.');
    expect(calculixNumber(1e-10)).toBe('1e-10');
    expect(calculixNumber((0.63 * 1.3) / 2)).toBe('0.4095');
    expect(nastranReal(250000)).toBe('250000.');
    expect(nastranReal(123456789)).toBeNull();
  });
});
