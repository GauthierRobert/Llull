/** Regressions of the PHY-02 review: sets and property links under replace/remove, caps, card-name injection, shift limits, load guard. */
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { deserializeDocument, serializeDocument } from '@core/commands/persistence/serialization';
import { runMaterialPoint } from '@core/model/materialLaws/driver';
import { pronyRecursion } from '@core/model/materialLaws/viscoelastic';
import { selectSlots } from '@core/commands/materiallab/setSelection';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import type { CommandResult } from '@core/commands/types';
import { nistDocument, nistModel } from '../propertyFixtures';
import {
  GPa,
  MPa,
  NL1_ELASTIC,
  NL1_PERFECT,
  ONE,
  SOURCE,
  T293,
  addModel,
  codeOf,
  defineSet,
  nl1Document,
  pointResponse,
  run,
  withMaterial,
} from './materialFixtures';

const steel = (): CadDocument => {
  let doc = withMaterial(createEmptyDocument(), 'steel');
  doc = addModel(doc, 'steel', 'el', NL1_ELASTIC);
  doc = addModel(doc, 'steel', 'pl', NL1_PERFECT);
  return defineSet(doc, 'steel', { id: 's', elastic: 'el', plastic: 'pl' });
};
const replace = (doc: CadDocument, id: string, model: Record<string, unknown>): CommandResult =>
  execute(doc, 'add_material_model', { material: 'steel', id, model, basis: 'typical', source: SOURCE, replace: true });

describe('H1 replace re-checks the sets that list the model', () => {
  it('refuses a replacement that breaks a set, naming the set', () => {
    const doc = steel();
    const creep = replace(doc, 'pl', { kind: 'creep_norton', A: 1e-10, n: 5, m: 0, stressUnit: 'MPa', timeUnit: 'h', hardening: 'time' });
    expect(creep.error?.code).toBe('MATL_COMBINATION_INVALID');
    expect(creep.error?.ids).toEqual(['pl', 's']);
    expect(creep.document).toBe(doc);
    let ortho = withMaterial(createEmptyDocument(), 'steel');
    ortho = addModel(ortho, 'steel', 'el', {
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
    ortho = addModel(ortho, 'steel', 'pl', {
      kind: 'j2_plasticity',
      isotropic: { kind: 'perfect', yieldStress: MPa(5) },
      kinematic: { kind: 'none' },
    });
    ortho = defineSet(ortho, 'steel', { id: 's', elastic: 'el', plastic: 'pl' });
    const voce = replace(ortho, 'pl', {
      kind: 'j2_plasticity',
      isotropic: { kind: 'voce', yieldStress: MPa(5), Q: MPa(5), b: 10 },
      kinematic: { kind: 'none' },
    });
    expect(voce.error?.code).toBe('MATL_COMBINATION_INVALID');
    expect(
      replace(doc, 'pl', { kind: 'j2_plasticity', isotropic: { kind: 'perfect', yieldStress: MPa(9) }, kinematic: { kind: 'none' } }).error,
    ).toBeUndefined();
  });
});

describe('H2 property models read by material laws', () => {
  const doc = (): CadDocument => {
    let d = nistDocument();
    d = addModel(d, 'aa6061_t6', 'elastic', { kind: 'elastic_isotropic', E: { propertyModelId: 'E' }, nu: ONE(0.33) });
    return d;
  };
  it('refuses to remove or re-dimension a property model a law reads', () => {
    const d = doc();
    expect(codeOf(d, 'remove_property_model', { material: 'aa6061_t6', modelId: 'E' })).toBe('PROP_MODEL_IN_USE');
    const wrong = execute(d, 'define_property_model', { material: 'aa6061_t6', model: nistModel('aa6061_t6.k', 'E'), replace: true });
    expect(wrong.error?.code).toBe('PROP_MODEL_IN_USE');
    expect(wrong.document).toBe(d);
    expect(
      execute(d, 'define_property_model', { material: 'aa6061_t6', model: nistModel('aa6061_t6.E', 'E'), replace: true }).error,
    ).toBeUndefined();
    expect(execute(d, 'remove_property_model', { material: 'aa6061_t6', modelId: 'k' }).error).toBeUndefined();
  });
});

describe('M2 / M4 caps', () => {
  it('caps the Prony fit terms, Chaboche back stresses, Prony series and command increments', () => {
    const doc = createEmptyDocument();
    const tau = Array.from({ length: 21 }, (_, i) => ({ value: 1 + i, unit: 's' }));
    const rows = Array.from({ length: 40 }, (_, i) => [i, 1000 - i]);
    expect(
      codeOf(doc, 'fit_material_model', {
        kind: 'visco_prony',
        tests: [{ mode: 'relaxation', rows, xMeasure: 'time', yMeasure: 'shear_modulus', units: { x: 's', y: 'MPa' } }],
        fixed: { tau },
      }),
    ).toBe('MATL_LAW_PARAMS_INVALID');
    const base = withMaterial(doc, 'm');
    const add = (model: Record<string, unknown>): string =>
      codeOf(base, 'add_material_model', { material: 'm', id: 'x', model, basis: 'typical', source: SOURCE });
    const terms = (n: number): { C: { value: number; unit: string }; gamma: number }[] =>
      Array.from({ length: n }, () => ({ C: MPa(10), gamma: 5 }));
    expect(
      add({
        kind: 'j2_plasticity',
        isotropic: { kind: 'perfect', yieldStress: MPa(5) },
        kinematic: { kind: 'chaboche', backstresses: terms(11) },
      }),
    ).toBe('MATL_LAW_PARAMS_INVALID');
    expect(
      add({
        kind: 'j2_plasticity',
        isotropic: { kind: 'perfect', yieldStress: MPa(5) },
        kinematic: { kind: 'chaboche', backstresses: terms(10) },
      }),
    ).toBe('accepted');
    const shear = (n: number): { g: number; tau: { value: number; unit: string } }[] =>
      Array.from({ length: n }, () => ({ g: 0.01, tau: { value: 1, unit: 's' } }));
    expect(add({ kind: 'visco_prony', shear: shear(21) })).toBe('MATL_LAW_PARAMS_INVALID');
    expect(
      add({ kind: 'visco_prony', shear: shear(1), bulk: Array.from({ length: 21 }, () => ({ k: 0.01, tau: { value: 1, unit: 's' } })) }),
    ).toBe('MATL_LAW_PARAMS_INVALID');
    expect(add({ kind: 'visco_prony', shear: shear(20) })).toBe('accepted');
    expect(
      codeOf(nl1Document(), 'material_point_response', {
        material: 'nl1_steel',
        kinematics: 'small',
        steps: [
          { increments: 60_000, control: { xx: { strain: 1e-5 } } },
          { increments: 60_000, control: { xx: { strain: 2e-5 } } },
        ],
      }),
    ).toBe('MATL_PATH_INVALID');
  });

  it('lets a direct driver call raise the increment limit', () => {
    const doc = nl1Document();
    const material = doc.materials['nl1_steel'];
    const selection = selectSlots(material ?? ({} as never), 'nl1_steel', 'perfect', undefined);
    if ('code' in selection) throw new Error(selection.message);
    const steps = [{ duration: null, temperatureK: null, increments: 150_000, control: { xx: { strain: 1e-5 } } }];
    const request = {
      record: { name: 'nl1_steel' },
      slots: selection.slots,
      kinematics: 'small' as const,
      preset: undefined,
      steps,
      output: 'steps' as const,
    };
    expect(runMaterialPoint(request)).toHaveProperty('code', 'MATL_PATH_INVALID');
    expect(runMaterialPoint({ ...request, maxIncrements: 200_000 })).toHaveProperty('rows');
  });
});

describe('M5 card name and header injection', () => {
  it('refuses unsafe names and strips line breaks from the header', () => {
    const doc = nl1Document();
    for (const name of ['A\n*INCLUDE,INPUT=x', 'A,B', '', 'a'.repeat(81)])
      expect(codeOf(doc, 'export_material_cards', { material: 'nl1_steel', target: 'calculix', name })).toBe('MATL_LAW_PARAMS_INVALID');
    let evil = withMaterial(createEmptyDocument(), 'a\n*INCLUDE,x');
    evil = addModel(evil, 'a\n*INCLUDE,x', 'e', NL1_ELASTIC, { validity: T293 });
    evil = defineSet(evil, 'a\n*INCLUDE,x', { id: 's\n,t', elastic: 'e' }, true);
    const data = run(evil, 'export_material_cards', { material: 'a\n*INCLUDE,x', target: 'calculix' }).data as {
      header: string;
      lines: string[];
    };
    expect(data.header).not.toMatch(/[\r\n]/);
    expect(data.lines.every((line) => !line.includes('\n'))).toBe(true);
    expect(data.lines[0]).toMatch(/^\*MATERIAL,NAME=[A-Z0-9_]+$/);
  });
});

describe('L1 shift limits', () => {
  it('keeps the strain increment when the reduced step is zero and refuses non-finite shifts', () => {
    expect(pronyRecursion(1, 0.5, 0, 5)).toBe(1.5);
    let doc = withMaterial(createEmptyDocument(), 'poly');
    doc = addModel(doc, 'poly', 'e', { kind: 'elastic_isotropic', E: MPa(3), nu: ONE(0.3) });
    doc = addModel(doc, 'poly', 'v', {
      kind: 'visco_prony',
      shear: [{ g: 0.3, tau: { value: 1, unit: 's' } }],
      shift: { kind: 'arrhenius', activationEnergy: { value: 1e9, unit: 'J/mol' }, referenceTemperature: { value: 300, unit: 'K' } },
    });
    doc = defineSet(doc, 'poly', { id: 's', elastic: 'e', viscoelastic: 'v' }, true);
    expect(
      codeOf(doc, 'material_point_response', {
        material: 'poly',
        kinematics: 'small',
        steps: [{ increments: 1, temperature: { value: 1, unit: 'K' }, control: { xy: { strain: 0.01 } } }],
      }),
    ).toBe('MATL_SHIFT_OUT_OF_RANGE');
  });
});

describe('L2 load guard parity', () => {
  const text = serializeDocument(nl1Document());
  const mutate = (change: (models: Record<string, unknown>[]) => void): string => {
    const copy = JSON.parse(text) as {
      document?: { materials: Record<string, Record<string, unknown>> };
      materials?: Record<string, Record<string, unknown>>;
    };
    const material = (copy.document?.materials ?? copy.materials ?? {})['nl1_steel'];
    change(material?.['materialModels'] as Record<string, unknown>[]);
    return JSON.stringify(copy);
  };
  it('rejects two preferred models of a kind, an empty citation and reviewedBy', () => {
    expect(() => deserializeDocument(mutate((m) => m.forEach((model, i) => i > 0 && Object.assign(model, { preferred: true }))))).toThrow(
      /MAT_PREFERRED_CONFLICT/,
    );
    expect(() => deserializeDocument(mutate((m) => void Object.assign(m[0]?.['provenance'] as object, { citation: ' ' })))).toThrow(
      /MAT_PROVENANCE_MISSING/,
    );
    expect(() => deserializeDocument(mutate((m) => void Object.assign(m[0] as object, { reviewedBy: { signatureId: 'x' } })))).toThrow(
      /reviewedBy/,
    );
  });
});

describe('L3 ad-hoc id and Ramberg-Osgood validity', () => {
  it('resolves an ad-hoc model by slot even when a stored model is called adhoc', () => {
    let doc = withMaterial(createEmptyDocument(), 'm');
    doc = addModel(doc, 'm', 'adhoc', NL1_ELASTIC);
    doc = defineSet(doc, 'm', { id: 's', elastic: 'adhoc' }, true);
    const data = pointResponse(doc, {
      material: 'm',
      set: 's',
      kinematics: 'small',
      preset: 'uniaxial_stress',
      model: { kind: 'j2_plasticity', isotropic: { kind: 'perfect', yieldStress: MPa(100) }, kinematic: { kind: 'none' } },
      steps: [{ increments: 10, control: { xx: { strain: 0.01 } } }],
    });
    expect(data.rows[0]?.stress[0]).toBeCloseTo(100, 4);
  });

  it('bounds the fitted plastic-strain validity by the plastic strain, not the total strain', () => {
    const E = 72000;
    const rows = [350, 380, 400, 420, 440].map((s) => [s / E + 0.002 * (s / 400) ** 15, s]);
    const fit = run(createEmptyDocument(), 'fit_material_model', {
      kind: 'ramberg_osgood',
      tests: [{ mode: 'uniaxial_plastic', rows, xMeasure: 'total_strain', yMeasure: 'true_stress', units: { y: 'MPa' } }],
      fixed: { E: GPa(72), nu: ONE(0.33) },
    }).data as { validity: { data: number[] }[] };
    const last = rows[rows.length - 1] ?? [0, 0];
    expect(fit.validity[0]?.data[1]).toBeCloseTo(0.002 * (440 / 400) ** 15, 9);
    expect(fit.validity[0]?.data[1]).toBeLessThan(last[0] ?? 0);
  });
});
