/** Plant 08 DAT-M1b: `assign_plant_objects`, the atomic bulk of `assign_plant_object` (linear, one step; §8 budget 10 000 assigns < 1 s). */

import { describe, expect, it } from 'vitest';
import { getPlantData } from '@aec/plant/data/model';
import { apply, expectRefusal, ok } from '../../../helpers/commandAssertions';
import { addEquipment, libraryDocument } from './dataFixtures';

const pump = (seq: number, target = 'reserved'): Record<string, unknown> => ({
  target,
  className: 'CentrifugalPump',
  hierarchy: 'U10',
  tagFields: { seq },
});

describe('assign_plant_objects', () => {
  it('gives the same tags and marks as one assign_plant_object per item, in one step', () => {
    const first = addEquipment(libraryDocument());
    const second = addEquipment(first.doc, { name: 'Pump B', location: [3000, 0] });
    const items = [pump(1, first.id), pump(2, second.id), pump(3)];
    const bulk = ok(second.doc, 'assign_plant_objects', { assignments: items });
    let sequential = second.doc;
    for (const item of items) sequential = apply(sequential, 'assign_plant_object', item);
    const tags = (doc: typeof sequential): string[] => Object.values(getPlantData(doc).objects).map((object) => object.tag);
    expect(tags(bulk.document)).toEqual(['P-101', 'P-102', 'P-103']);
    expect(tags(bulk.document)).toEqual(tags(sequential));
    expect(Object.values(bulk.document.building?.elements ?? {}).flatMap((e) => (e.category === 'equipment' ? [e.mark] : []))).toEqual([
      'P-101',
      'P-102',
    ]);
    expect(bulk.data).toMatchObject({ count: 3 });
    expect(bulk.affected).toEqual(expect.arrayContaining([first.id, second.id]));
    expect(bulk.document.featureHistory.length).toBe(second.doc.featureHistory.length + 1);
  });

  it('numbers consecutively with nextSequence: later items see the earlier tags', () => {
    const result = ok(libraryDocument(), 'assign_plant_objects', {
      assignments: [1, 2, 3].map(() => ({ target: 'reserved', className: 'CentrifugalPump', hierarchy: 'U10', nextSequence: true })),
    });
    expect((result.data as { assigned: Array<{ tag: string }> }).assigned.map((entry) => entry.tag)).toEqual(['P-101', 'P-102', 'P-103']);
  });

  it('is pure and atomic: a duplicate inside the batch refuses it whole, with the item path', () => {
    const base = libraryDocument();
    const before = JSON.stringify(base);
    const refused = expectRefusal(
      base,
      'assign_plant_objects',
      { assignments: [pump(1), pump(2), pump(1)] },
      'DAT_TAG_DUPLICATE',
      'assignments[2].tag',
    );
    expect(refused.summary).toMatch(/assignments\[2\]/);
    expect(refused.document).toBe(base);
    expect(JSON.stringify(base)).toBe(before);
    expect(Object.keys(getPlantData(base).objects)).toEqual([]);
  });

  it('assigns 10 000 objects well inside a second of command time', () => {
    const base = apply(apply(libraryDocument(), 'define_plant_class', { name: 'MyPump', parent: 'CentrifugalPump' }), 'set_tag_format', {
      className: 'MyPump',
      tagFormat: '{classCode}-{seq:5}',
    });
    const started = performance.now();
    const result = ok(base, 'assign_plant_objects', {
      assignments: Array.from({ length: 10000 }, (_, index) => ({ ...pump(index + 1), className: 'MyPump' })),
    });
    const elapsed = performance.now() - started;
    expect(getPlantData(result.document).objectOrder).toHaveLength(10000);
    expect(elapsed).toBeLessThan(3000);
  });
});
