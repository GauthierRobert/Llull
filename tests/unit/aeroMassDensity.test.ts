import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { execute } from '@core/commands/registry';
import { createEmptyDocument } from '@core/model/types';
import type { CadDocument } from '@core/model/types';
import { resolveDensity } from '@core/geometry/resolveDensity';
import { bodyMassProperties } from '@core/dynamics/simulationModel';

const PACK = 'docs/aerospace/08-materials-standards-libraries/validation/expected_results.json';
interface Expected {
  unitConversion: { id: string; input: { density: number; unit: string }; expected: Record<string, number> }[];
  massProperties: { id: string; expected: Record<string, number> }[];
}
const expected = JSON.parse(readFileSync(PACK, 'utf8')) as Expected;
const SOURCE = { citation: 'synthetic test fixture', locator: 'tests/unit/aeroMassDensity' };

const run = (doc: CadDocument, name: string, params: Record<string, unknown>): CadDocument => execute(doc, name, params).document;
const massOf = (doc: CadDocument, entityId: string, extra: Record<string, unknown> = {}): Record<string, unknown> =>
  execute(doc, 'mass_properties', { entityId, ...extra }).data as Record<string, unknown>;
const expectedMass = (id: string): Record<string, number> => {
  const row = expected.massProperties.find((entry) => entry.id.startsWith(id));
  if (row === undefined) throw new Error(`no expected row ${id}`);
  return row.expected;
};

const densityModel = (
  id: string,
  value: number,
  unit: string,
  basis: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> => ({
  id,
  property: 'density',
  unit,
  variables: [],
  validity: [],
  form: { kind: 'constant', value },
  basis,
  source: SOURCE,
  ...extra,
});

/** One solid with a material `name` (legacy density `legacy` g/unit³) assigned. */
function part(
  units: 'mm' | 'in',
  add: [string, Record<string, unknown>],
  name = 'alloy',
  legacy = 0.0027,
): { doc: CadDocument; id: string } {
  let doc = run(createEmptyDocument(), 'set_units', { units });
  const added = execute(doc, add[0], add[1]);
  const id = added.affected[0] ?? '';
  doc = run(added.document, 'create_material', { name, density: legacy, color: '#aaaaaa', metalness: 1, roughness: 0.4 });
  return { doc: run(doc, 'assign_material', { materialName: name, entityIds: [id] }), id };
}
const withModel = (doc: CadDocument, model: Record<string, unknown>, material = 'alloy'): CadDocument =>
  run(doc, 'define_property_model', { material, model });

describe('AERO-1 / 08 M1: one density resolver, unit-correct mass', () => {
  it('VC-MAT-03: density conversions through create_material densityUnit', () => {
    for (const row of expected.unitConversion) {
      const doc = run(run(createEmptyDocument(), 'set_units', { units: 'mm' }), 'create_material', {
        name: 'm',
        density: row.input.density,
        densityUnit: row.input.unit,
        color: '#aaaaaa',
        metalness: 1,
        roughness: 0.4,
      });
      expect(Math.abs((doc.materials.m?.density ?? 0) / (row.expected['g/mm^3'] ?? 1) - 1)).toBeLessThan(1e-9);
    }
  });

  it('VC-MAT-01 / VC-MAT-22 legacy row: a legacy material density keeps the old mass and is flagged unverified', () => {
    const { doc, id } = part('mm', ['add_box', { size: [10, 10, 10] }], 'steel', 0.00785);
    const data = massOf(doc, id);
    expect(data.massG).toBeCloseTo(7.85, 12);
    expect(data).toMatchObject({ mass: data.massG, unit: 'g', massUnit: 'g', unverified: true, unverifiedReasons: ['provenance legacy'] });
    expect(data.densitySource).toContain("material 'steel' density (legacy");
  });

  it('VC-MAT-04 a/b/c: a PHY-01 density model wins over the legacy density, with its basis in the unverified reasons', () => {
    const box = part('mm', ['add_box', { size: [100, 50, 10] }]);
    const typical = massOf(withModel(box.doc, densityModel('rho_typical', 2.81, 'g/cm^3', 'typical')), box.id, { massUnit: 'kg' });
    expect(
      Math.abs((typical.massG as number) / (expectedMass('VC-MAT-04/box_100x50x10_mm/aa7075_t6/density_typical').mass_g ?? 0) - 1),
    ).toBeLessThan(1e-9);
    expect(typical).toMatchObject({ massUnit: 'kg', unverified: true, unverifiedReasons: ['basis typical'], densityDefaulted: false });
    expect(typical.mass).toBeCloseTo(0.1405, 12);
    expect(typical.massLb).toBeCloseTo(0.3097495, 6);
    expect(typical.unit).toBeUndefined();
    expect(typical.densitySource).toBe("material 'alloy' property model 'rho_typical'");

    const supplier = massOf(withModel(box.doc, densityModel('rho_ams', 0.101, 'lb/in^3', 'supplier_unstated')), box.id);
    expect(Math.abs((supplier.massG as number) / 139.7835 - 1)).toBeLessThan(1e-6);
    expect(supplier.unverifiedReasons).toEqual(['basis supplier_unstated']);

    const cylinder = part('mm', ['add_cylinder', { radius: 10, height: 50 }]);
    const ti = massOf(withModel(cylinder.doc, densityModel('rho', 0.16, 'lb/in^3', 'S')), cylinder.id);
    expect(Math.abs((ti.massG as number) / (expectedMass('VC-MAT-04/cylinder_r10_h50_mm').mass_g ?? 0) - 1)).toBeLessThan(1e-6);
    expect(ti).toMatchObject({ unverified: false, unverifiedReasons: [] });
  });

  it('VC-MAT-04 e: an inch document reports pounds correctly from a { value, unit } density param', () => {
    const doc = run(createEmptyDocument(), 'set_units', { units: 'in' });
    const added = execute(doc, 'add_box', { size: [2, 1, 0.25] });
    const id = added.affected[0] ?? '';
    const data = massOf(added.document, id, { density: { value: 0.101, unit: 'lb/in^3' }, massUnit: 'lb' });
    const row = expectedMass('VC-MAT-04/box_2x1x0.25_in');
    expect(Math.abs((data.mass as number) / (row.mass_lb ?? 0) - 1)).toBeLessThan(1e-9);
    expect(Math.abs((data.massG as number) / (row.mass_g ?? 0) - 1)).toBeLessThan(1e-6);
    expect(data).toMatchObject({ massUnit: 'lb', densityUnit: 'g/in³', densityDefaulted: false, unverified: true });
  });

  it('refuses instead of falling back when the density models cannot be used', () => {
    const { doc, id } = part('mm', ['add_box', { size: [1, 1, 1] }]);
    const two = withModel(withModel(doc, densityModel('rho_a', 2.8, 'g/cm^3', 'typical')), densityModel('rho_b', 2.7, 'g/cm^3', 'S'));
    const ambiguous = execute(two, 'mass_properties', { entityId: id });
    expect(ambiguous.data).toBeUndefined();
    expect(ambiguous.error?.code).toBe('PROP_NO_MODEL_FOR_PROPERTY');
    expect(ambiguous.error?.ids).toEqual([id]);
    const hot = withModel(doc, {
      ...densityModel('rho_hot', 2.7, 'g/cm^3', 'S'),
      variables: [{ variable: 'T', unit: 'K' }],
      validity: [{ variable: 'T', unit: 'K', data: [400, 600] }],
    });
    expect(execute(hot, 'mass_properties', { entityId: id, density: 1 }).error?.code).toBe('PROP_OUT_OF_RANGE');
  });

  it('rejects a bad density param with a stable code', () => {
    const { doc, id } = part('mm', ['add_box', { size: [1, 1, 1] }]);
    expect(execute(doc, 'mass_properties', { entityId: id, density: { value: 2.8, unit: 'MPa' } }).error?.code).toBe('MAT_UNIT_DIMENSION');
    expect(execute(doc, 'mass_properties', { entityId: id, density: { value: -1, unit: 'g/cm^3' } }).error?.code).toBe(
      'MAT_DENSITY_INVALID',
    );
    expect(execute(doc, 'mass_properties', { entityId: id, density: 0 }).error?.code).toBe('MAT_DENSITY_INVALID');
    const badUnit = execute(doc, 'create_material', {
      name: 'x',
      density: 1,
      densityUnit: 'MPa',
      color: '#aaaaaa',
      metalness: 0,
      roughness: 0,
    });
    expect(badUnit.error?.code).toBe('MAT_UNIT_DIMENSION');
    expect(badUnit.document).toBe(doc);
  });

  it('is pure', () => {
    const { doc, id } = part('mm', ['add_box', { size: [10, 10, 10] }]);
    const before = structuredClone(doc);
    execute(doc, 'mass_properties', { entityId: id, density: { value: 2.7, unit: 'g/cm^3' }, massUnit: 'kg' });
    expect(doc).toEqual(before);
  });

  it('resolveDensity: param fallback and no density at all', () => {
    const doc = createEmptyDocument();
    expect(resolveDensity(doc, undefined)).toBeNull();
    expect(resolveDensity(doc, 'missing', { kgPerM3: 1000, source: 'param', defaulted: false })).toMatchObject({
      available: true,
      kgPerM3: 1000,
      gPerDocUnit3: 0.001,
      unverifiedReasons: ['given by the caller (param)'],
    });
  });

  it('dynamics reads the same resolver: density model, named steel default, massKg override', () => {
    const { doc, id } = part('mm', ['add_box', { size: [100, 100, 100] }]);
    const modelled = withModel(doc, densityModel('rho', 2.7, 'g/cm^3', 'S'));
    const body = { id: 'b', entityIds: [id], fixed: false };
    const props = bodyMassProperties(modelled, body);
    if ('error' in props) throw new Error(props.error);
    expect(props.mass).toBeCloseTo(2.7, 12);
    expect(props).toMatchObject({
      densitySources: ["material 'alloy' property model 'rho'"],
      densityDefaulted: false,
      unverifiedReasons: [],
    });

    const bare = execute(run(createEmptyDocument(), 'set_units', { units: 'mm' }), 'add_box', { size: [100, 100, 100] });
    const steel = bodyMassProperties(bare.document, { id: 'b', entityIds: [bare.affected[0] ?? ''], fixed: false });
    if ('error' in steel) throw new Error(steel.error);
    expect(steel.mass).toBeCloseTo(7.85, 12);
    expect(steel.densityDefaulted).toBe(true);
    const inspected = execute(run(bare.document, 'add_rigid_body', { entityIds: [bare.affected[0] ?? ''] }), 'inspect_dynamics', {});
    const report = inspected.data as { warnings: string[]; bodies: Record<string, { densityDefaulted: boolean; unverified: boolean }> };
    expect(report.warnings.some((warning) => warning.startsWith('DYN_DENSITY_DEFAULTED'))).toBe(true);
    expect(Object.values(report.bodies)[0]).toMatchObject({ densityDefaulted: true, unverified: true });

    const fixedMass = bodyMassProperties(bare.document, { id: 'b', entityIds: [bare.affected[0] ?? ''], fixed: false, massKg: 2 });
    if ('error' in fixedMass) throw new Error(fixedMass.error);
    expect(fixedMass).toMatchObject({ mass: 2, densityDefaulted: false });

    const ambiguous = withModel(modelled, densityModel('rho_b', 2.8, 'g/cm^3', 'typical'));
    expect(bodyMassProperties(ambiguous, body)).toMatchObject({ error: expect.stringContaining('PROP_NO_MODEL_FOR_PROPERTY') as unknown });
  });
});
