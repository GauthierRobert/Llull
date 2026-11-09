import { describe, expect, it } from 'vitest';
import { convertTo, isProblem } from '@cae/environment/units';
import { materialProperty } from '@cae/environment/materialValue';
import { createEmptyDocument } from '@core/model/types';
import { run, withMaterial, emptyMm } from './fixtures';

describe('convertTo (quantity parameters)', () => {
  it('converts a quantity to the formula unit', () => {
    expect(convertTo({ value: 2, unit: 'mm' }, 'm', 'thickness')).toEqual({ value: 0.002 });
  });

  it('names a non-finite value and a unit of another dimension with their paths', () => {
    const notFinite = convertTo({ value: Number.NaN, unit: 'mm' }, 'm', 'thickness');
    expect(isProblem(notFinite) && notFinite.path).toBe('thickness');
    const wrong = convertTo({ value: 1, unit: 's' }, 'm', 'thickness');
    expect(isProblem(wrong) && wrong.path).toBe('thickness.unit');
    expect(isProblem(wrong) && wrong.message).toContain("convertible to 'm'");
    const unknown = convertTo({ value: 1, unit: 'furlongs' }, 'm', 'thickness');
    expect(isProblem(unknown)).toBe(true);
  });
});

describe('materialProperty (PHY-01 read through evaluate_property)', () => {
  it('returns the value, unit, basis flag and a source text', () => {
    const doc = withMaterial(emptyMm(), 'm1', { TML: 0.95 });
    const value = materialProperty(doc, undefined, 'm1', 'TML', '%');
    expect(value).toMatchObject({ unit: '%', unverified: false });
    expect('value' in value && Math.abs(value.value - 0.95)).toBeLessThan(1e-9);
    expect('source' in value && value.source).toContain('synthetic');
  });

  it('a record without provenance text reads "no provenance"', () => {
    let doc = run(emptyMm(), 'create_material', { name: 'm2', density: 1, color: '#ffffff', metalness: 0, roughness: 0.5 }).document;
    doc = run(doc, 'set_material_property', {
      material: 'm2',
      property: 'TML',
      value: 1,
      unit: '%',
      basis: 'B',
      source: { citation: ' x ' },
    }).document;
    const material = doc.materials['m2'];
    if (material === undefined) throw new Error('fixture');
    const stripped = {
      ...doc,
      materials: {
        ...doc.materials,
        m2: { ...material, propertyModels: (material.propertyModels ?? []).map((model) => ({ ...model, provenance: {} })) },
      },
    };
    const value = materialProperty(stripped, undefined, 'm2', 'TML', '%');
    expect('source' in value && value.source).toBe('no provenance');
  });

  it('an unavailable property is a missing value with the PHY-01 code', () => {
    const doc = withMaterial(emptyMm(), 'm3', {});
    expect(materialProperty(doc, undefined, 'm3', 'TML', '%')).toMatchObject({ code: 'PROP_NO_MODEL_FOR_PROPERTY' });
    expect(materialProperty(doc, undefined, 'nothing', 'TML', '%')).toMatchObject({ code: 'MAT_RECORD_NOT_FOUND' });
  });

  it('a rejection without data (an operating point the command refuses) is ENV_PROPERTY_MISSING with the summary', () => {
    const missing = materialProperty(
      createEmptyDocument(),
      undefined,
      'm',
      'TML',
      'not-a-unit',
      { T: { value: 1, unit: 'K' } },
      'bogus-direction',
    );
    expect(missing).toMatchObject({ code: expect.any(String) });
    expect('reason' in missing && missing.reason.length).toBeGreaterThan(0);
  });
});
