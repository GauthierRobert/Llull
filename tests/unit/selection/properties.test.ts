import { describe, expect, it } from 'vitest';
import { dataOf, run, step, syntheticDocument, withMaterial } from './fixtures';

interface Excluded {
  readonly material: string;
  readonly code: string;
  readonly reason: string;
  readonly missing?: string[];
}

interface Result {
  readonly value: number;
  readonly inputs: { property: string; value: number; direction?: string; propertyValueId: string }[];
}

const base = syntheticDocument();
const SOURCE = 'test fixture: allowables per direction and thickness';

/** A plate with an isotropic E and density, and Fty tabulated per direction and thickness band (08 MAT allowables). */
const plate = withMaterial(base, 'plate', [
  { property: 'density', value: 2.8, unit: 'g/cm^3', basis: 'company', citation: SOURCE },
  { property: 'E', value: 70, unit: 'GPa', basis: 'company', citation: SOURCE },
]);
const banded = (direction: string, value: number, min: number, max: number, id: string, doc = plate): ReturnType<typeof step> =>
  step(doc, 'set_material_property', {
    material: 'plate',
    property: 'Fty',
    value,
    unit: 'MPa',
    basis: 'A',
    direction,
    thickness: { min, max, unit: 'in' },
    id,
    source: { citation: SOURCE },
  });
const doc = banded('LT', 450, 0.05, 0.1, 'Fty.LT', banded('L', 480, 0.05, 0.1, 'Fty.L'));

const strength = (extra: Record<string, unknown>): ReturnType<typeof run> =>
  run(doc, 'material_index', { materials: ['plate'], indices: ['tie_strength'], strengthProperty: 'Fty', ...extra });

describe('property resolution of a selection (direction, thickness)', () => {
  it('an exact-direction value inside its thickness band answers; the thickness converts (2 mm lies in 0.05 .. 0.1 in)', () => {
    const result = strength({ direction: 'L', thickness: { value: 2, unit: 'mm' } });
    const row = (dataOf(result)['results'] as Result[])[0];
    expect(row?.inputs[0]).toMatchObject({ property: 'Fty', value: 480, direction: 'L', propertyValueId: 'Fty.L' });
    expect(row?.value).toBeCloseTo(480 / 2.8, 9);
    const other = (dataOf(strength({ direction: 'LT', thickness: { value: 2, unit: 'mm' } }))['results'] as Result[])[0];
    expect(other?.inputs[0]?.propertyValueId).toBe('Fty.LT');
  });

  it('a value with a thickness band is ignored without a thickness or outside the band (excluded, never substituted)', () => {
    for (const extra of [{ direction: 'L' }, { direction: 'L', thickness: { value: 5, unit: 'mm' } }]) {
      const excluded = dataOf(strength(extra))['excluded'] as Excluded[];
      expect(excluded).toEqual([expect.objectContaining({ code: 'SEL_PROPERTY_MISSING', missing: ['Fty'] })]);
    }
  });

  it('without a direction a directional value is not an isotropic one; another direction has no value; an isotropic E answers any direction', () => {
    const thickness = { value: 2, unit: 'mm' };
    expect(dataOf(strength({ thickness }))['excluded']).toEqual([expect.objectContaining({ missing: ['Fty'] })]);
    expect(dataOf(strength({ direction: 'ST', thickness }))['excluded']).toEqual([expect.objectContaining({ missing: ['Fty'] })]);
    const stiffness = run(doc, 'material_index', { materials: ['plate'], indices: ['beam_stiffness'], direction: 'ST' });
    expect((dataOf(stiffness)['results'] as Result[])[0]?.inputs.find((input) => input.property === 'E')?.value).toBe(70);
  });

  it('an out-of-range thickness unit is refused as invalid params, not guessed', () => {
    const refused = strength({ thickness: { value: 2, unit: 'kg' } });
    expect(refused.error).toMatchObject({ code: 'SEL_PARAMS_INVALID' });
    expect(refused.document).toBe(doc);
    expect(strength({ thickness: { value: Number.NaN, unit: 'mm' } }).rejected).toBe(true);
  });

  it('a private-library record whose values are not on this machine is excluded with MAT_LIBRARY_UNRESOLVED', () => {
    const unresolved = {
      ...doc,
      materials: {
        ...doc.materials,
        ghost: {
          ...(doc.materials['plate'] as NonNullable<(typeof doc.materials)['plate']>),
          name: 'ghost',
          record: {
            id: 'ghost',
            designation: 'ghost',
            specs: [],
            licence: 'legacy',
            exportMarking: { regime: 'none' },
            unresolved: { reason: 'library_not_registered' },
          },
        },
      },
    } as unknown as typeof doc;
    const result = run(unresolved, 'material_index', { materials: ['ghost'], indices: ['beam_stiffness'] });
    expect(dataOf(result)['excluded']).toEqual([expect.objectContaining({ material: 'ghost', code: 'MAT_LIBRARY_UNRESOLVED' })]);
  });

  it('a stored value in another unit is converted to the base unit (ksi -> MPa) and reported in it', () => {
    const imperial = withMaterial(base, 'imperial', [
      { property: 'density', value: 0.1, unit: 'lb/in^3', basis: 'company', citation: SOURCE },
      { property: 'E', value: 10.3, unit: 'Msi', basis: 'company', citation: SOURCE },
    ]);
    const row = (
      dataOf(run(imperial, 'material_index', { materials: ['imperial'], indices: ['tie_stiffness'] }))['results'] as Result[]
    )[0];
    expect(row?.inputs.map((input) => [input.property, Number(input.value.toPrecision(6))])).toEqual([
      ['E', 71.016],
      ['density', 2.76799],
    ]);
  });
});
