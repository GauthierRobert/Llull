import { describe, it, expect } from 'vitest';
import { createEmptyDocument } from '@core/model/types';
import type { CadDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import {
  footprintOutline,
  footprintOutlineDistSq,
  solidFootprint,
} from '../../src/ui/viewport/2d/solidFootprint';
import { nearestEntityId } from '../../src/ui/viewport/2d/modifyHelpers';

function add(doc: CadDocument, name: string, params: unknown): { doc: CadDocument; id: string } {
  const result = execute(doc, name, params);
  return { doc: result.document, id: result.affected[0] as string };
}

describe('solidFootprint', () => {
  it('is the XY extent of a centred box', () => {
    const { doc, id } = add(createEmptyDocument(), 'add_box', {
      size: [4, 2, 1],
      position: [10, 5, 0],
    });
    expect(solidFootprint(doc, doc.entities[id]!)).toEqual({
      minX: 8,
      minY: 4,
      maxX: 12,
      maxY: 6,
    });
  });

  it('follows a Z rotation of the solid (core rotation-aware bounds)', () => {
    const { doc, id } = add(createEmptyDocument(), 'add_box', {
      size: [4, 2, 1],
      position: [10, 5, 0],
      rotation: [0, 0, Math.PI / 2],
    });
    const rect = solidFootprint(doc, doc.entities[id]!)!;
    expect(rect.minX).toBeCloseTo(9);
    expect(rect.maxX).toBeCloseTo(11);
    expect(rect.minY).toBeCloseTo(3);
    expect(rect.maxY).toBeCloseTo(7);
  });

  it('covers a cylinder by its radius and an instance by its component', () => {
    const cyl = add(createEmptyDocument(), 'add_cylinder', {
      radius: 3,
      height: 2,
      position: [0, 0, 0],
    });
    const cylRect = solidFootprint(cyl.doc, cyl.doc.entities[cyl.id]!)!;
    expect(cylRect.maxX - cylRect.minX).toBeCloseTo(6);

    const box = add(createEmptyDocument(), 'add_box', { size: [2, 2, 2], position: [5, 5, 0] });
    const comp = add(box.doc, 'create_component', { name: 'Unit', entityIds: [box.id] });
    const instance = comp.doc.entities[comp.id]!;
    expect(instance.kind).toBe('instance');
    expect(solidFootprint(comp.doc, instance)).toEqual({ minX: 4, minY: 4, maxX: 6, maxY: 6 });
  });

  it('returns null for 2D shapes', () => {
    const { doc, id } = add(createEmptyDocument(), 'draw_circle', { center: [0, 0], radius: 1 });
    expect(solidFootprint(doc, doc.entities[id]!)).toBeNull();
  });

  it('builds a closed outline and measures distance to the outline, inside or outside', () => {
    const rect = { minX: 0, minY: 0, maxX: 4, maxY: 2 };
    const outline = footprintOutline(rect);
    expect(outline).toHaveLength(5);
    expect(outline[0]).toEqual(outline[4]);
    expect(footprintOutlineDistSq(rect, [5, 1])).toBe(1);
    expect(footprintOutlineDistSq(rect, [2, 1.5])).toBeCloseTo(0.25);
    expect(footprintOutlineDistSq(rect, [0, 1])).toBe(0);
  });

  it('lets 2D picking hit a solid near its footprint outline', () => {
    const { doc, id } = add(createEmptyDocument(), 'add_box', {
      size: [4, 2, 1],
      position: [10, 5, 0],
    });
    expect(nearestEntityId(doc, [12.05, 5], 0.2)).toBe(id);
    expect(nearestEntityId(doc, [10, 5], 0.2)).toBeNull();
  });
});
