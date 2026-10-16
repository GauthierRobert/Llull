/** VC-MATL-17 (FR-MATL-14): law parameters that reference PHY-01 property models; refusal codes pass through. */
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { expectCase } from '../benchmarkCases';
import { PACK as PROPERTY_PACK, nistDocument } from '../propertyFixtures';
import type { CadDocument } from '@core/model/types';
import { ONE, SOURCE, addModel, codeOf, defineSet, pointResponse, run } from './materialFixtures';

function aluminium(): CadDocument {
  let doc = nistDocument();
  doc = addModel(
    doc,
    'aa6061_t6',
    'elastic',
    { kind: 'elastic_isotropic', E: { propertyModelId: 'E' }, nu: ONE(0.33) },
    { basis: 'typical' },
  );
  return defineSet(doc, 'aa6061_t6', { id: 'cryo', elastic: 'elastic' }, true);
}

const at = (kelvin: number): Record<string, unknown> => ({
  material: 'aa6061_t6',
  kinematics: 'small',
  preset: 'uniaxial_stress',
  steps: [{ increments: 2, temperature: { value: kelvin, unit: 'K' }, control: { xx: { strain: 1e-4 } } }],
});

describe('property-model references (VC-MATL-17)', () => {
  const doc = aluminium();

  it('uses E(T) of 6061-T6 at 77 K', () => {
    const stress = pointResponse(doc, at(77)).rows[0]?.stress[0] ?? Number.NaN;
    expectCase(PROPERTY_PACK, 'VC-PROP-07/aa6061_t6.E/T=77K', stress / 1e-4 / 1000, 'GPa');
  });

  it('passes the PHY-01 refusal through at 400 K and propagates the unverified reasons', () => {
    const result = execute(doc, 'material_point_response', at(400));
    expect(result.error?.code).toBe('PROP_OUT_OF_RANGE');
    expect(result.rejected).toBe(true);
    expect(codeOf(doc, 'material_point_response', { ...at(77), steps: [{ increments: 1, control: { xx: { strain: 1e-4 } } }] })).toBe(
      'PROP_VARIABLE_MISSING',
    );
    const data = pointResponse(doc, at(77));
    expect(data.unverified).toBe(true);
    expect(data.unverifiedReasons).toContain("elastic 'elastic': property model 'E': basis typical");
    expect(data.unverifiedReasons).toContain("property model 'E': basis typical");
  });

  it('evaluates the referenced model at every export temperature', () => {
    const withValidity = addModel(
      doc,
      'aa6061_t6',
      'elastic',
      { kind: 'elastic_isotropic', E: { propertyModelId: 'E' }, nu: ONE(0.33) },
      { basis: 'typical', replace: true, validity: [{ variable: 'T', unit: 'K', data: [4, 295] }] },
    );
    const lines = (
      run(withValidity, 'export_material_cards', {
        material: 'aa6061_t6',
        target: 'calculix',
        temperatures: [
          { value: 77, unit: 'K' },
          { value: 295, unit: 'K' },
        ],
      }).data as { lines: string[] }
    ).lines;
    expect(lines).toHaveLength(4);
    expect(Number(lines[2]?.split(',')[0])).toBeCloseTo(77145.0506573, 3);
    expect(lines[3]).toMatch(/^70284\.04144\d*,0\.33,295\.$/);
    expect(
      codeOf(withValidity, 'export_material_cards', {
        material: 'aa6061_t6',
        target: 'calculix',
        temperatures: [{ value: 400, unit: 'K' }],
      }),
    ).toBe('PROP_OUT_OF_RANGE');
  });

  it('refuses references to unknown models and to models of the wrong dimension', () => {
    const add = (E: Record<string, unknown>): string =>
      codeOf(doc, 'add_material_model', {
        material: 'aa6061_t6',
        id: 'x',
        model: { kind: 'elastic_isotropic', E, nu: ONE(0.33) },
        basis: 'typical',
        source: SOURCE,
      });
    expect(add({ propertyModelId: 'nope' })).toBe('MATL_LAW_PARAMS_INVALID');
    expect(add({ propertyModelId: 'k' })).toBe('MATL_LAW_PARAMS_INVALID');
    expect(add({ propertyModelId: 'E' })).toBe('accepted');
  });
});
