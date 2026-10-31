/** deform_overlay and deform_jacobian_map answer in WORLD coordinates: the recipe frame is kernel-local, so a moved / rotated body is drawn at the entity placement (the rule of the viewport). */

import { afterEach, describe, expect, it } from 'vitest';
import type { CadDocument, Vec3 } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { setGeometryKernel } from '@core/geometry/kernel';
import { entityLocalToWorld } from '@core/geometry/entityFrame';
import { applyEulerXYZ } from '@lib/eulerRotation';
import { WORLD_Z, addBox, dataOf, installKernel } from './harness';

afterEach(() => setGeometryKernel(null));

const PLACEMENT = { position: [5, -3, 2] as Vec3, rotation: [0.3, -0.5, 0.8] as Vec3 };
const near = (actual: readonly number[], expected: readonly number[]): void => {
  expect(actual).toHaveLength(expected.length);
  actual.forEach((value, k) => expect(value).toBeCloseTo(expected[k] as number, 5));
};

async function twisted(): Promise<{ doc: CadDocument; id: string; placed: CadDocument }> {
  await installKernel('none');
  const { doc, id } = addBox();
  const made = execute(doc, 'twist_body', {
    id,
    angleDeg: 36,
    frame: WORLD_Z,
    region: { start: 0, end: 20, infinite: true },
    output: { tolerance: 0.01 },
  });
  const next = made.affected[0] as string;
  const entity = made.document.entities[next];
  if (entity === undefined) throw new Error('twisted body expected');
  return {
    doc: made.document,
    id: next,
    placed: { ...made.document, entities: { ...made.document.entities, [next]: { ...entity, ...PLACEMENT } } },
  };
}

interface Overlay {
  frame: { origin: Vec3; x: Vec3; y: Vec3; z: Vec3; length: number };
  region: { startCentre: Vec3; endCentre: Vec3; radius: number };
  reference: Vec3[][];
}

describe('deform_overlay placement', () => {
  it('the frame, region centres and reference wire of a moved and rotated body are the entity placement of the local ones; lengths and directions rotate only', async () => {
    const { doc, id, placed } = await twisted();
    const compareTo = { kind: 'plane', point: [0, 0, 3], normal: [0, 0, 1] };
    const local = dataOf<Overlay>(execute(doc, 'deform_overlay', { id, compareTo }));
    const world = dataOf<Overlay>(execute(placed, 'deform_overlay', { id, compareTo }));
    const entity = placed.entities[id] as never;
    near(world.frame.origin, entityLocalToWorld(entity, local.frame.origin));
    for (const axis of ['x', 'y', 'z'] as const) near(world.frame[axis], applyEulerXYZ(local.frame[axis], [0, 0, 0], PLACEMENT.rotation));
    near(world.region.startCentre, entityLocalToWorld(entity, local.region.startCentre));
    near(world.region.endCentre, entityLocalToWorld(entity, local.region.endCentre));
    expect(world.frame.length).toBeCloseTo(local.frame.length, 9);
    expect(world.region.radius).toBeCloseTo(local.region.radius, 9);
    expect(world.reference.length).toBeGreaterThan(0);
    world.reference.forEach((line, i) =>
      line.forEach((point, k) => near(point, entityLocalToWorld(entity, local.reference[i]?.[k] as Vec3))),
    );
  });

  it('the lattice net of a moved body is placed too (rest, moved and the box corners)', async () => {
    await installKernel('none');
    const { doc, id } = addBox([10, 10, 100]);
    const made = execute(doc, 'deform_lattice', {
      id,
      frame: WORLD_Z,
      box: { min: [-5, -5, 0], max: [5, 5, 100] },
      degrees: [2, 2, 6],
      splineDegrees: [2, 2, 2],
      moves: [{ index: [1, 1, 3], delta: [2, 0, 0] }],
      output: { tolerance: 0.01 },
    });
    expect(made.error, made.summary).toBeUndefined();
    const next = made.affected[0] as string;
    const entity = { ...made.document.entities[next], ...PLACEMENT } as never;
    const placed: CadDocument = { ...made.document, entities: { ...made.document.entities, [next]: entity } };
    type Lattice = { lattice: { rest: Vec3[]; moved: Vec3[]; box: Vec3[] } };
    const local = dataOf<Lattice>(execute(made.document, 'deform_overlay', { id: next })).lattice;
    const world = dataOf<Lattice>(execute(placed, 'deform_overlay', { id: next })).lattice;
    for (const key of ['rest', 'moved', 'box'] as const) {
      expect(world[key].length).toBeGreaterThan(0);
      world[key].forEach((point, k) => near(point, entityLocalToWorld(entity, local[key][k] as Vec3)));
    }
  });
});

describe('deform_jacobian_map placement', () => {
  it('the positions of a moved and rotated body are the entity placement of the local ones; determinants and indices do not change', async () => {
    const { doc, id, placed } = await twisted();
    type Map = { positions: number[]; indices: number[]; determinant: number[] };
    const local = dataOf<Map>(execute(doc, 'deform_jacobian_map', { id }));
    const world = dataOf<Map>(execute(placed, 'deform_jacobian_map', { id }));
    expect(world.indices).toEqual(local.indices);
    expect(world.determinant).toEqual(local.determinant);
    expect(world.positions.length).toBe(local.positions.length);
    expect(world.positions.length).toBeGreaterThan(0);
    const entity = placed.entities[id] as never;
    for (let i = 0; i < local.positions.length; i += 3) {
      const expected = entityLocalToWorld(entity, [
        local.positions[i] as number,
        local.positions[i + 1] as number,
        local.positions[i + 2] as number,
      ]);
      [0, 1, 2].forEach((k) => expect(world.positions[i + k]).toBeCloseTo(expected[k] as number, 4));
    }
  });
});
