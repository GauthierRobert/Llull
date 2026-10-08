import { describe, it, expect } from 'vitest';
import { createEmptyDocument } from '@core/model/types';
import type {
  BoxEntity,
  CadDocument,
  CylinderEntity,
  Entity,
  InstanceEntity,
  MeshSolidEntity,
  Vec3,
} from '@core/model/types';
import { execute } from '@core/commands/registry';
import { expandInstance } from '@core/commands/instanceExpansion';

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

function bakedEntities(scale: number[]): Entity[] {
  const { doc, componentId } = withComponent();
  const inserted = execute(doc, 'insert_instance', { componentId, position: [10, 0, 0], scale });
  const exploded = execute(inserted.document, 'explode_instance', { id: inserted.affected[0]! });
  return exploded.affected.map((id) => exploded.document.entities[id]!);
}

/** A one-child component from `add` (applied to an empty doc), instanced with `scale` / `rotation`. */
function singleChildInstance(
  add: [string, Record<string, unknown>],
  scale: Vec3,
  rotation: Vec3 = [0, 0, 0],
): { doc: CadDocument; instanceId: string; children: Entity[] } {
  const added = execute(createEmptyDocument(), add[0], add[1]);
  const created = execute(added.document, 'create_component', {
    name: 'One',
    entityIds: [added.affected[0]!],
    componentId: 'comp-one',
  });
  const inserted = execute(created.document, 'insert_instance', {
    componentId: 'comp-one',
    position: [0, 0, 0],
    rotation,
    scale,
  });
  const instanceId = inserted.affected[0]!;
  const instance = inserted.document.entities[instanceId] as InstanceEntity;
  const component = inserted.document.components['comp-one']!;
  return { doc: inserted.document, instanceId, children: expandInstance(instance, component) };
}

function meshPoints(entity: Entity): Vec3[] {
  expect(entity.kind).toBe('mesh');
  const positions = (entity as MeshSolidEntity).mesh.positions;
  const points: Vec3[] = [];
  for (let i = 0; i + 2 < positions.length; i += 3) {
    points.push([positions[i]!, positions[i + 1]!, positions[i + 2]!]);
  }
  return points;
}

function extents(points: readonly Vec3[]): { min: Vec3; max: Vec3 } {
  const axis = (k: 0 | 1 | 2, pick: (...values: number[]) => number): number =>
    pick(...points.map((point) => point[k]));
  return {
    min: [axis(0, Math.min), axis(1, Math.min), axis(2, Math.min)],
    max: [axis(0, Math.max), axis(1, Math.max), axis(2, Math.max)],
  };
}

function expectVecClose(actual: Vec3, expected: Vec3): void {
  actual.forEach((value, k) => expect(value).toBeCloseTo(expected[k]!, 9));
}

function volumeOf(doc: CadDocument, entityId: string): number {
  const result = execute(doc, 'measure_volume', { entityId });
  return (result.data as { volume: number }).volume;
}

describe('explode_instance bakes the instance scale into the geometry', () => {
  it('uniform scale scales sizes as well as positions (parametric path)', () => {
    const baked = bakedEntities([2, 2, 2]);
    const box = baked.find((e) => e.kind === 'box') as BoxEntity;
    const cylinder = baked.find((e) => e.kind === 'cylinder') as CylinderEntity;
    expect(box.size).toEqual([4, 8, 12]);
    expect(box.position[0]).toBeCloseTo(10 + 2);
    expect(cylinder.radius).toBeCloseTo(2);
    expect(cylinder.height).toBeCloseTo(4);
  });

  it('non-uniform scale stretches an unrotated box per axis and bakes round kinds into a mesh', () => {
    const baked = bakedEntities([1, 2, 4]);
    expect((baked.find((e) => e.kind === 'box') as BoxEntity).size).toEqual([2, 8, 24]);
    expect(baked.some((e) => e.kind === 'cylinder')).toBe(false);
    const cylinderMesh = baked.find((e) => e.kind === 'mesh')!;
    const { min, max } = extents(meshPoints(cylinderMesh));
    expectVecClose(min, [10 - 1, -2, -4]);
    expectVecClose(max, [10 + 1, 2, 4]);
  });

  it('a negative component mirrors the geometry through a baked mesh', () => {
    const baked = bakedEntities([-1, 1, 1]);
    expect(baked.map((e) => e.kind)).toEqual(['mesh', 'mesh']);
    const boxMesh = baked[0]!;
    const { min, max } = extents(meshPoints(boxMesh));
    // box spans x 0..2 at position 1 → mirrored -2..0, then +10
    expect(min[0]).toBeCloseTo(8);
    expect(max[0]).toBeCloseTo(10);
  });

  it('unit scale leaves geometry untouched and a zero scale does not produce NaN', () => {
    const unit = bakedEntities([1, 1, 1]);
    expect((unit.find((e) => e.kind === 'box') as BoxEntity).size).toEqual([2, 4, 6]);
    for (const entity of bakedEntities([0, 1, 1])) {
      expect(meshPoints(entity).flat().every(Number.isFinite)).toBe(true);
    }
  });
});

describe('expandInstance bakes non-uniform / mirrored scale exactly', () => {
  it('a cylinder scaled [2, 1, 1] is an elliptic cylinder of section area π·2r·r', () => {
    const radius = 1.5;
    const height = 2;
    const { doc, instanceId, children } = singleChildInstance(
      ['add_cylinder', { radius, height }],
      [2, 1, 1],
    );
    const { min, max } = extents(meshPoints(children[0]!));
    expectVecClose(min, [-2 * radius, -radius, -height / 2]);
    expectVecClose(max, [2 * radius, radius, height / 2]);
    const sectionArea = volumeOf(doc, instanceId) / height;
    const ellipseArea = Math.PI * 2 * radius * radius;
    // 24-segment tessellation: polygon/circle area ratio = 12·sin(π/12)/π ≈ 0.9886
    expect(sectionArea / ellipseArea).toBeCloseTo((12 * Math.sin(Math.PI / 12)) / Math.PI, 6);
  });

  it('a rotated box under a non-uniform scale is scaled along the instance axes', () => {
    // size [2, 4, 2] rotated 90° about Z occupies x ±2, y ±1; scale x2 → x ±4, y ±1.
    const { doc, instanceId, children } = singleChildInstance(
      ['add_box', { size: [2, 4, 2], rotation: [0, 0, Math.PI / 2] }],
      [2, 1, 1],
    );
    const { min, max } = extents(meshPoints(children[0]!));
    expectVecClose(min, [-4, -1, -1]);
    expectVecClose(max, [4, 1, 1]);
    expect(volumeOf(doc, instanceId)).toBeCloseTo(2 * 4 * 2 * 2, 9);
  });

  it('an instance rotation is applied after the scale', () => {
    const { children } = singleChildInstance(
      ['add_box', { size: [2, 4, 2], rotation: [0, 0, Math.PI / 2] }],
      [1, 3, 1],
      [0, 0, Math.PI / 2],
    );
    // child spans x ±2, y ±1 → scale y×3 → x ±2, y ±3 → rotate 90° → x ±3, y ±2.
    const { min, max } = extents(meshPoints(children[0]!));
    expectVecClose(min, [-3, -2, -1]);
    expectVecClose(max, [3, 2, 1]);
  });

  it('a negative scale mirrors a wedge and keeps its volume positive', () => {
    const size: Vec3 = [2, 3, 4];
    const { doc, instanceId, children } = singleChildInstance(
      ['add_wedge', { size, position: [1, 0, 0] }],
      [-1, 1, 1],
    );
    const points = meshPoints(children[0]!);
    const { min, max } = extents(points);
    expectVecClose(min, [-3, 0, 0]);
    expectVecClose(max, [-1, 3, 4]);
    // the full-height front edge (x = 1 + 2, y = 3, z = 0) mirrors to x = -3
    expect(points.some(([x, y, z]) => x === -3 && y === 3 && z === 0)).toBe(true);
    expect(points.some(([, y, z]) => y === 3 && z === 4)).toBe(false);
    expect(volumeOf(doc, instanceId)).toBeCloseTo((2 * 3 * 4) / 2, 9);
  });

  it('a uniform positive scale keeps parametric children', () => {
    const { children } = singleChildInstance(['add_cylinder', { radius: 1, height: 2 }], [3, 3, 3]);
    expect(children[0]).toMatchObject({ kind: 'cylinder', radius: 3, height: 6 });
  });
});
