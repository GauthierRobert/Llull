import { describe, expect, it } from 'vitest';
import { deserializeDocument, serializeDocument } from '@core/commands/persistence/serialization';
import type { EquipmentElement } from '@aec/building/types';
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

describe('load: a corrupt plant record is rejected with a description, never a crash', () => {
  const stored = JSON.parse(serializeDocument(separatorDocument())) as {
    document: { building: { elements: Record<string, { plant: Record<string, unknown> }> } };
  };
  const withPlant = (change: (plant: Record<string, unknown>) => void): string => {
    const copy = JSON.parse(JSON.stringify(stored)) as typeof stored;
    change(copy.document.building.elements['equipment-1']?.plant as Record<string, unknown>);
    return JSON.stringify(copy);
  };
  const template = (plant: Record<string, unknown>): Record<string, unknown> => plant['template'] as Record<string, unknown>;
  const nozzle = (plant: Record<string, unknown>): Record<string, unknown> =>
    (plant['nozzles'] as Array<Record<string, unknown>>)[0] as Record<string, unknown>;

  it('round trips a sound document with the same equipment and entities', () => {
    const original = separatorDocument();
    const loaded = deserializeDocument(serializeDocument(original));
    expect(Object.keys(loaded.entities).sort()).toEqual(Object.keys(original.entities).sort());
    const [before, after] = [original, loaded].map((doc) => doc.building?.elements['equipment-1'] as EquipmentElement);
    expect(after?.plant).toEqual(before?.plant);
    expect([after?.size, after?.shape, after?.weight]).toEqual([before?.size, before?.shape, before?.weight]);
  });

  it.each([
    ['empty plant', (plant: Record<string, unknown>) => Object.keys(plant).forEach((key) => delete plant[key]), /plant\.schema/],
    ['unknown template kind', (plant: Record<string, unknown>) => (template(plant)['kind'] = 'tank'), /template\.kind/],
    ['vessel without heads', (plant: Record<string, unknown>) => delete template(plant)['heads'], /heads\.first/],
    ['non-positive diameter', (plant: Record<string, unknown>) => (template(plant)['insideDiameter'] = -5), /insideDiameter/],
    ['unknown support', (plant: Record<string, unknown>) => (template(plant)['support'] = { type: 'wheels' }), /support\.type/],
    ['nozzles not an array', (plant: Record<string, unknown>) => (plant['nozzles'] = {}), /nozzles must be an array/],
    ['nozzle without flange', (plant: Record<string, unknown>) => delete nozzle(plant)['flange'], /flange/],
    ['nozzle with a bad location', (plant: Record<string, unknown>) => (nozzle(plant)['location'] = { on: 'moon' }), /location\.on/],
    ['nozzle without a mark', (plant: Record<string, unknown>) => (nozzle(plant)['mark'] = ''), /mark/],
  ])('%s', (_name, change, message) => {
    let failure: unknown;
    try {
      deserializeDocument(withPlant(change));
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(TypeError);
    expect(String(failure)).toMatch(message);
  });
});
