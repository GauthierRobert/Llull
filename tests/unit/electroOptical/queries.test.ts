import { describe, expect, it } from 'vitest';
import type { CadDocument } from '@core/model/types';
import { createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import type { CommandResult } from '@core/commands/types';
import { oracle, run, runPlan } from './fixtures';

const SRC = { citation: 'test input (not a property claim)' };
const COPPER = { value: 1.7241e-8, unit: 'ohm*m' };

type Data = Record<string, unknown>;
const ask = (
  doc: CadDocument,
  name: string,
  params: Record<string, unknown>,
): { data: Data; code: string | undefined; ok: boolean; doc: CadDocument } => {
  const result = execute(doc, name, params);
  return { data: (result.data ?? {}) as Data, code: result.error?.code, ok: result.error === undefined, doc: result.document };
};

const rel = (actual: unknown, expected: number): number => Math.abs((actual as number) - expected) / Math.abs(expected);

describe('electrical_resistance (VC-EOP-02, 03, 04)', () => {
  const base = createEmptyDocument();

  it('R = rho L / A for 1 m of 1 mm^2 copper (0.017241 ohm)', () => {
    const { data } = ask(base, 'electrical_resistance', {
      resistivity: COPPER,
      length: { value: 1, unit: 'm' },
      crossSection: { value: 1, unit: 'mm^2' },
    });
    expect(rel(data['dcOhm'], oracle('VC-EOP-02.a'))).toBeLessThan(1e-9);
    expect(data).toMatchObject({ formula: 'R = rho L / A', unverified: true, murDefaulted: true });
  });

  it('reads rho from a material model at the temperature and names the model', () => {
    const { doc } = runPlan('eop_bonding_paths.plan.json', 'define_bond_path');
    const { data } = ask(doc, 'electrical_resistance', {
      material: 'strap_61iacs',
      length: { value: 150, unit: 'mm' },
      crossSection: { value: 10, unit: 'mm^2' },
    });
    expect(rel(data['dcOhm'], 0.000423959016393)).toBeLessThan(1e-9);
    expect(data['unverified']).toBe(false);
    expect(String((data['provenance'] as string[])[0])).toContain('strap_61iacs');
  });

  it.each([
    [60, 'VC-EOP-03.a'],
    [1e6, 'VC-EOP-03.b'],
  ])('skin depth of 100 %% IACS copper at %s Hz', (hertz, id) => {
    const { data } = ask(base, 'electrical_resistance', {
      resistivity: COPPER,
      length: { value: 1, unit: 'm' },
      crossSection: { value: 1, unit: 'mm^2' },
      frequency: { value: hertz, unit: 'Hz' },
    });
    expect(rel(data['skinDepthM'], oracle(id))).toBeLessThan(1e-6);
  });

  it('skin depth of a magnetic conductor uses mur (VC-EOP-03.c)', () => {
    const { data } = ask(base, 'electrical_resistance', {
      resistivity: { value: 1e-7, unit: 'ohm*m' },
      length: { value: 1, unit: 'm' },
      crossSection: { value: 1, unit: 'mm^2' },
      frequency: { value: 400, unit: 'Hz' },
      mur: 100,
    });
    expect(rel(data['skinDepthM'], oracle('VC-EOP-03.c'))).toBeLessThan(1e-6);
    expect(data['murDefaulted']).toBe(false);
  });

  it('round wire AC/DC ratio r / (2 delta) = 7.566 at 1 MHz, valid (VC-EOP-04); thin regimes are flagged', () => {
    const wire = { resistivity: COPPER, length: { value: 1, unit: 'm' }, crossSection: { value: Math.PI, unit: 'mm^2' } };
    const thick = ask(base, 'electrical_resistance', {
      ...wire,
      frequency: { value: 1, unit: 'MHz' },
      radius: { value: 1, unit: 'mm' },
    }).data;
    expect(rel(thick['acOverDc'], oracle('VC-EOP-04'))).toBeLessThan(0.05);
    expect(thick['validity']).toMatchObject({ approximate: false });
    const mid = ask(base, 'electrical_resistance', {
      ...wire,
      frequency: { value: 100, unit: 'kHz' },
      radius: { value: 1, unit: 'mm' },
    }).data;
    expect(mid['validity']).toMatchObject({ approximate: true });
    const dc = ask(base, 'electrical_resistance', { ...wire, frequency: { value: 50, unit: 'Hz' }, radius: { value: 1, unit: 'mm' } }).data;
    expect(dc['acOverDc']).toBe(1);
    expect(dc['validity']).toMatchObject({ approximate: true });
  });

  it.each([
    ['both material and resistivity', { material: 'x', resistivity: COPPER }, 'EOP_PARAMS_INVALID'],
    ['neither', {}, 'EOP_PARAMS_INVALID'],
    ['a resistivity in S/m', { resistivity: { value: 5.8e7, unit: 'S/m' } }, 'EOP_UNITS_MISMATCH'],
    ['a zero resistivity', { resistivity: { value: 0, unit: 'ohm*m' } }, 'EOP_UNITS_MISMATCH'],
    ['an unknown material', { material: 'ghost' }, 'EOP_RESISTIVITY_UNAVAILABLE'],
    ['a negative length', { resistivity: COPPER, length: { value: -1, unit: 'm' } }, 'EOP_PARAMS_INVALID'],
    ['an area in a length unit', { resistivity: COPPER, crossSection: { value: 1, unit: 'mm' } }, 'EOP_PARAMS_INVALID'],
    ['a radius without frequency', { resistivity: COPPER, radius: { value: 1, unit: 'mm' } }, 'EOP_PARAMS_INVALID'],
    ['a zero frequency', { resistivity: COPPER, frequency: { value: 0, unit: 'Hz' } }, 'EOP_PARAMS_INVALID'],
    [
      'a negative radius',
      { resistivity: COPPER, frequency: { value: 1, unit: 'MHz' }, radius: { value: -1, unit: 'mm' } },
      'EOP_PARAMS_INVALID',
    ],
    ['a non-positive mur', { resistivity: COPPER, mur: 0 }, 'EOP_PARAMS_INVALID'],
  ])('refuses %s and leaves the document unchanged', (_label, extra, code) => {
    const params = { length: { value: 1, unit: 'm' }, crossSection: { value: 1, unit: 'mm^2' }, ...extra };
    const result = ask(base, 'electrical_resistance', params);
    expect(result.code).toBe(code);
    expect(result.doc).toBe(base);
  });

  it('is pure', () => {
    const before = structuredClone(base);
    ask(base, 'electrical_resistance', { resistivity: COPPER, length: { value: 1, unit: 'm' }, crossSection: { value: 1, unit: 'mm^2' } });
    expect(base).toEqual(before);
  });
});

describe('shield_absorption (VC-EOP-05)', () => {
  const base = createEmptyDocument();

  it('0.1 mm copper at 1 MHz gives 13.1436 dB and says absorption term only', () => {
    const { data } = ask(base, 'shield_absorption', {
      resistivity: COPPER,
      thickness: { value: 0.1, unit: 'mm' },
      frequency: { value: 1, unit: 'MHz' },
    });
    expect(rel(data['dB'], oracle('VC-EOP-05'))).toBeLessThan(1e-6);
    expect(String(data['note'])).toContain('absorption term only');
  });

  it('a magnetic sheet absorbs more (mur) and the material route works', () => {
    const plain = ask(base, 'shield_absorption', {
      resistivity: COPPER,
      thickness: { value: 0.1, unit: 'mm' },
      frequency: { value: 1, unit: 'MHz' },
    }).data['dB'] as number;
    const magnetic = ask(base, 'shield_absorption', {
      resistivity: COPPER,
      thickness: { value: 0.1, unit: 'mm' },
      frequency: { value: 1, unit: 'MHz' },
      mur: 100,
    }).data['dB'] as number;
    expect(magnetic / plain).toBeCloseTo(10, 9);
    const { doc } = runPlan('eop_bonding_paths.plan.json', 'define_bond_path');
    expect(
      ask(doc, 'shield_absorption', {
        material: 'strap_61iacs',
        thickness: { value: 0.1, unit: 'mm' },
        frequency: { value: 1, unit: 'MHz' },
      }).ok,
    ).toBe(true);
  });

  it.each([
    ['a zero thickness', { thickness: { value: 0, unit: 'mm' }, frequency: { value: 1, unit: 'MHz' } }],
    ['a frequency in a length unit', { thickness: { value: 1, unit: 'mm' }, frequency: { value: 1, unit: 'mm' } }],
    ['a negative mur', { thickness: { value: 1, unit: 'mm' }, frequency: { value: 1, unit: 'MHz' }, mur: -1 }],
  ])('refuses %s', (_label, extra) => {
    const result = ask(base, 'shield_absorption', { resistivity: COPPER, ...extra });
    expect(result.code).toBe('EOP_PARAMS_INVALID');
    expect(result.doc).toBe(base);
  });

  it('refuses without a resistivity source', () => {
    expect(ask(base, 'shield_absorption', { thickness: { value: 1, unit: 'mm' }, frequency: { value: 1, unit: 'MHz' } }).code).toBe(
      'EOP_PARAMS_INVALID',
    );
  });
});

describe('normal_reflectance (VC-EOP-09)', () => {
  const base = createEmptyDocument();

  it('n = 1.5 in air gives R = 0.04 and a lossless slab T = 0.923077; n1 is a named default', () => {
    const { data } = ask(base, 'normal_reflectance', { n2: 1.5 });
    expect(rel(data['R'], oracle('VC-EOP-09.a'))).toBeLessThan(1e-12);
    expect(rel(data['slabT'], oracle('VC-EOP-09.b'))).toBeLessThan(1e-12);
    expect(data).toMatchObject({ n1: 1, n1Defaulted: true, unverified: true });
  });

  it('an absorbing medium gets R with k and no slab transmittance', () => {
    const { data } = ask(base, 'normal_reflectance', { n2: 0.2, k: 3.5, n1: 1, wavelength: { value: 550, unit: 'nm' } });
    expect(rel(data['R'], ((1 - 0.2) ** 2 + 3.5 ** 2) / ((1 + 0.2) ** 2 + 3.5 ** 2))).toBeLessThan(1e-12);
    expect(data['slabT']).toBeUndefined();
    expect(data['wavelength']).toEqual({ value: 550, unit: 'nm' });
  });

  it('a non-finite number is rejected by the schema before the command runs', () => {
    expect(ask(base, 'normal_reflectance', { n2: Infinity }).code).toBe('CMD_INVALID_PARAMS');
  });

  it.each([
    ['n2 below 1 for a lossless medium', { n2: 0.5 }],
    ['n1 below 1', { n2: 1.5, n1: 0.5 }],
    ['a negative k', { n2: 1.5, k: -1 }],
    ['a non-positive n2 with k', { n2: 0, k: 1 }],
  ])('refuses %s', (_label, params) => {
    const result = ask(base, 'normal_reflectance', params);
    expect(result.code).toBe('EOP_PARAMS_INVALID');
    expect(result.doc).toBe(base);
  });
});

describe('check_surface_properties', () => {
  const { doc, aliases } = runPlan('eop_radiator_coating.plan.json', 'optical_balance');
  const panel = aliases['panel'] ?? '';
  const record = (id: string): Record<string, unknown> => ({
    id,
    designation: 't',
    productForm: 'coating',
    specs: [],
    licence: 'company-proprietary',
    exportMarking: { regime: 'none' },
  });
  const items = (
    document: CadDocument,
    params: Record<string, unknown> = {},
  ): { status: string; items: { status: string; findings: { code: string }[] }[]; unmatched: string[] } =>
    ask(document, 'check_surface_properties', params).data as never;

  it('the plan coating has BOL alpha and hemispherical eps but no EOL alpha: warn, with the named finding', () => {
    const data = items(doc);
    expect(data.status).toBe('warn');
    expect(data.items[0]?.findings.map((finding) => finding.code)).toEqual(['EOP_SURFACE_PROPERTY_MISSING']);
  });

  it('a coating with no optical models fails (missing values are never guessed); a bonded coating of unknown effect warns', () => {
    const bare = run(run(doc, 'define_material_record', record('bare')), 'assign_surface_coating', {
      entityId: panel,
      coating: 'bare',
      location: 'bonded_interface',
    });
    const exposed = run(run(bare, 'define_material_record', record('bare2')), 'add_box', { size: [1, 1, 1] });
    const second = execute(exposed, 'add_box', { size: [1, 1, 1] });
    const withBare = run(second.document, 'assign_surface_coating', { entityId: second.affected[0], coating: 'bare2' });
    const data = items(withBare);
    expect(data.status).toBe('fail');
    const codes = data.items.flatMap((item) => item.findings.map((finding) => finding.code));
    expect(codes).toContain('EOP_COATING_UNKNOWN');
    expect(codes.filter((code) => code === 'EOP_SURFACE_PROPERTY_MISSING').length).toBeGreaterThanOrEqual(2);
  });

  it('an unverified-basis value warns EOP_PROPERTY_UNVERIFIED', () => {
    const model = {
      id: 'eps_ht',
      property: 'emissivityIr',
      unit: '1',
      variables: [],
      form: { kind: 'constant', value: 0.8 },
      validity: [],
      basis: 'typical',
      condition: { opticalKind: 'hemispherical_total' },
      source: SRC,
      preferred: true,
    };
    const replaced = run(doc, 'define_property_model', { material: 'white_paint_test', replace: true, model });
    expect(items(replaced).items[0]?.findings.map((finding) => finding.code)).toContain('EOP_PROPERTY_UNVERIFIED');
  });

  it('scopes to entityIds and lists the unmatched ones; a missing coating record fails', () => {
    expect(items(doc, { entityIds: ['nope'] })).toMatchObject({ status: 'pass', items: [], unmatched: ['nope'] });
    const orphan = { ...doc, materials: Object.fromEntries(Object.entries(doc.materials).filter(([id]) => id !== 'white_paint_test')) };
    expect(items(orphan).items[0]?.findings[0]?.code).toBe('EOP_COATING_NOT_FOUND');
  });

  it('is pure and read-only', () => {
    const before = structuredClone(doc);
    const result = execute(doc, 'check_surface_properties', {});
    expect(doc).toEqual(before);
    expect(result.document).toBe(doc);
  });
});

describe('define_property_model: emissivityIr / absorptivitySolar range (TR-EOP-02, VC-EOP-10)', () => {
  const { doc } = runPlan('eop_radiator_coating.plan.json', 'define_property_model');
  const define = (property: string, form: unknown, condition: Record<string, string>): CommandResult =>
    execute(doc, 'define_property_model', {
      material: 'white_paint_test',
      model: {
        id: 'm',
        property,
        unit: '1',
        variables: form === 'table' ? [{ variable: 'T', unit: 'K' }] : [],
        form:
          form === 'table'
            ? {
                kind: 'table1d',
                variable: 'T',
                points: [
                  [100, 0.5],
                  [400, 1.2],
                ],
                interpolation: 'linear',
              }
            : form,
        validity: form === 'table' ? [{ variable: 'T', unit: 'K', data: [100, 400] }] : [],
        basis: 'company',
        condition,
        source: SRC,
      },
    });

  it.each([
    ['emissivityIr', 1.05, { opticalKind: 'hemispherical_total' }],
    ['absorptivitySolar', -0.1, { lifeState: 'BOL' }],
  ])('refuses %s = %s with EOP_PROPERTY_RANGE and leaves the document unchanged', (property, value, condition) => {
    const result = define(property, { kind: 'constant', value }, condition);
    expect(result.error?.code).toBe('EOP_PROPERTY_RANGE');
    expect(result.document).toBe(doc);
  });

  it('refuses a table point and a nested piecewise segment outside [0, 1]; accepts the bounds 0 and 1', () => {
    expect(define('emissivityIr', 'table', { opticalKind: 'hemispherical_total' }).error?.code).toBe('EOP_PROPERTY_RANGE');
    const piecewise = {
      kind: 'piecewise',
      variable: 'T',
      segments: [
        { upTo: 300, form: { kind: 'constant', value: 0.5 } },
        { upTo: 400, form: { kind: 'constant', value: 2 } },
      ],
    };
    const nested = execute(doc, 'define_property_model', {
      material: 'white_paint_test',
      model: {
        id: 'p',
        property: 'emissivityIr',
        unit: '1',
        variables: [{ variable: 'T', unit: 'K' }],
        form: piecewise,
        validity: [{ variable: 'T', unit: 'K', data: [100, 400] }],
        basis: 'company',
        condition: { opticalKind: 'hemispherical_total' },
        source: SRC,
      },
    });
    expect(nested.error?.code).toBe('EOP_PROPERTY_RANGE');
    expect(define('emissivityIr', { kind: 'constant', value: 0 }, { opticalKind: 'hemispherical_total' }).error).toBeUndefined();
    expect(define('absorptivitySolar', { kind: 'constant', value: 1 }, { lifeState: 'EOL' }).error).toBeUndefined();
  });

  it('refuses an unknown condition value for lifeState / opticalKind', () => {
    expect(define('absorptivitySolar', { kind: 'constant', value: 0.5 }, { lifeState: 'MOL' }).error?.code).toBe('PROP_FORM_INVALID');
    expect(define('emissivityIr', { kind: 'constant', value: 0.5 }, { opticalKind: 'spectral' }).error?.code).toBe('PROP_FORM_INVALID');
  });
});
