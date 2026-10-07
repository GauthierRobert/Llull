import { describe, it, expect } from 'vitest';
import { createEmptyDocument } from '@core/model/types';
import type { BoxEntity, CylinderEntity } from '@core/model/types';
import { execute } from '@core/commands/registry';

function withComponent(): { doc: ReturnType<typeof createEmptyDocument>; componentId: string } {
  const box = execute(createEmptyDocument(), 'add_box', { size: [2, 4, 6], position: [1, 0, 0] });
  const cylinder = execute(box.document, 'add_cylinder', { radius: 1, height: 2 });
  const created = execute(cylinder.document, 'create_component', {
    name: 'Part',
    entityIds: [box.affected[0]!, cylinder.affected[0]!],
    componentId: 'comp-part',
  });
  return { doc: created.document, componentId: 'comp-part' };
}

function bakedEntities(scale: number[]): { box: BoxEntity; cylinder: CylinderEntity } {
  const { doc, componentId } = withComponent();
  const inserted = execute(doc, 'insert_instance', { componentId, position: [10, 0, 0], scale });
  const exploded = execute(inserted.document, 'explode_instance', { id: inserted.affected[0]! });
  const baked = exploded.affected.map((id) => exploded.document.entities[id]!);
  return {
    box: baked.find((e) => e.kind === 'box') as BoxEntity,
    cylinder: baked.find((e) => e.kind === 'cylinder') as CylinderEntity,
  };
}

describe('explode_instance bakes the instance scale into the geometry', () => {
  it('uniform scale scales sizes as well as positions', () => {
    const { box, cylinder } = bakedEntities([2, 2, 2]);
    expect(box.size).toEqual([4, 8, 12]);
    expect(box.position[0]).toBeCloseTo(10 + 2);
    expect(cylinder.radius).toBeCloseTo(2);
    expect(cylinder.height).toBeCloseTo(4);
  });

  it('non-uniform scale stretches boxes per axis and uses the geometric mean elsewhere', () => {
    const { box, cylinder } = bakedEntities([1, 2, 4]);
    expect(box.size).toEqual([2, 8, 24]);
    expect(cylinder.radius).toBeCloseTo(2);
  });

  it('a negative component mirrors position but keeps sizes positive', () => {
    const { box } = bakedEntities([-1, 1, 1]);
    expect(box.size).toEqual([2, 4, 6]);
    expect(box.position[0]).toBeCloseTo(10 - 1);
  });

  it('unit scale leaves geometry untouched and a zero scale does not produce NaN', () => {
    expect(bakedEntities([1, 1, 1]).box.size).toEqual([2, 4, 6]);
    const flat = bakedEntities([0, 1, 1]);
    expect(Number.isFinite(flat.cylinder.radius)).toBe(true);
    expect(flat.box.size.every(Number.isFinite)).toBe(true);
  });
});
