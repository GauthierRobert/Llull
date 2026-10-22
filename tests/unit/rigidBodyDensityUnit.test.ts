/** ENG-10: add_rigid_body takes the same `densityUnit` option as create_material; the body density is stored in kg/m³. */
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { createEmptyDocument, type CadDocument } from '@core/model/types';

/** A 100 mm cube: 1e-3 m³, so the mass in kg is the density in kg/m³ / 1000. */
function cube(): { doc: CadDocument; id: string } {
  const result = execute(createEmptyDocument(), 'add_box', { size: [100, 100, 100], position: [0, 0, 0] });
  return { doc: result.document, id: result.affected[0] ?? '' };
}

describe('add_rigid_body densityUnit', () => {
  it('converts g/cm³ to the stored kg/m³ and weighs the body with it', () => {
    const { doc, id } = cube();
    const result = execute(doc, 'add_rigid_body', { id: 'b', entityIds: [id], density: 2.7, densityUnit: 'g/cm^3' });
    expect(result.affected).toEqual(['b']);
    expect(result.document.dynamics?.bodies['b']?.density).toBeCloseTo(2700, 9);
    expect(result.summary).toContain('2.700 kg');
  });

  it('a bare density stays kg/m³ (unchanged default)', () => {
    const { doc, id } = cube();
    const result = execute(doc, 'add_rigid_body', { id: 'b', entityIds: [id], density: 2700 });
    expect(result.document.dynamics?.bodies['b']?.density).toBe(2700);
    expect(result.summary).toContain('2.700 kg');
  });

  it('refuses an unknown or non-density unit, and a unit without a density', () => {
    const { doc, id } = cube();
    for (const params of [
      { entityIds: [id], density: 2.7, densityUnit: 'furlong' },
      { entityIds: [id], density: 2.7, densityUnit: 'm' },
      { entityIds: [id], densityUnit: 'g/cm^3' },
    ]) {
      const result = execute(doc, 'add_rigid_body', params);
      expect(result.document).toBe(doc);
      expect(result.affected).toEqual([]);
    }
    expect(execute(doc, 'add_rigid_body', { entityIds: [id], densityUnit: 'g/cm^3' }).summary).toContain(
      'densityUnit given without density',
    );
  });
});
