import { describe, expect, it } from 'vitest';
import { buildingErrors } from '@aec/building/validate';
import { apply, data } from '../../../helpers/commandAssertions';
import { separatorDocument } from './equipmentFixtures';

interface Schedule {
  columns: string[];
  rows: unknown[][];
}

describe('legacy equipment consumers keep working on a parametric vessel (TR-EQP-02: clash, schedules, IFC, validation)', () => {
  const doc = apply(separatorDocument(), 'add_equipment', { name: 'Skid', location: [5300, 5000], size: [1000, 1000, 1000], mark: 'P-1' });

  it('the building model with plant data passes the load-time validation, also after a JSON round trip', () => {
    expect(buildingErrors(JSON.parse(JSON.stringify(doc.building)))).toEqual([]);
  });

  it('the equipment schedule lists the derived size, weight and shape', () => {
    const schedule = data<Schedule>(doc, 'building_schedule', { kind: 'equipment' });
    const row = schedule.rows.find((candidate) => candidate[0] === 'V-101');
    expect(row?.slice(1, 3)).toEqual(['HP separator', 'Level 0']);
    expect(row?.[5]).toBe('1540×1540×6385');
    expect(row?.[8]).toBe('vertical_vessel');
    expect(Number(row?.[7])).toBeCloseTo(5262.0996, 3);
  });

  it('check_clashes sees the derived bounding box', () => {
    const { clashes } = data<{ clashes: Array<{ a: string; b: string; kind: string }> }>(doc, 'check_clashes', {});
    expect(clashes).toEqual([{ a: 'equipment-1', b: 'equipment-2', kind: 'hard', depth: 970 }]);
  });

  it('export_ifc exports the vessel as a product', () => {
    const exported = data<{ productCount: number; elementCount: number }>(doc, 'export_ifc', {});
    expect(exported.productCount).toBe(2);
    expect(exported.elementCount).toBe(2);
  });
});
