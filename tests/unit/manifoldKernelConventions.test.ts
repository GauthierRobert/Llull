import { beforeAll, describe, expect, it } from 'vitest';
import type { Entity, Vec3 } from '@core/model/types';
import { createEmptyDocument } from '@core/model/types';
import type { GeometryKernel, MeshData } from '@core/geometry/kernel';
import { entityToTriangles } from '@core/commands/export';
import { createManifoldKernel } from '@core/geometry/manifoldKernel';

let kernel: GeometryKernel;

beforeAll(async () => {
  kernel = await createManifoldKernel();
});

const base = { layerId: 'layer-default', color: '#888888' };

function solid(fields: Record<string, unknown>): Entity {
  return { id: 'e', rotation: [0, 0, 0], ...base, ...fields } as unknown as Entity;
}

type Bounds = { min: Vec3; max: Vec3 };

function meshBounds(mesh: MeshData): Bounds {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < mesh.positions.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const v = mesh.positions[i + k]!;
      min[k] = Math.min(min[k]!, v);
      max[k] = Math.max(max[k]!, v);
    }
  }
  return { min: min as unknown as Vec3, max: max as unknown as Vec3 };
}

function llullBounds(entity: Entity): Bounds {
  const positions: number[] = [];
  for (const t of entityToTriangles(entity, createEmptyDocument())) {
    for (const v of t) positions.push(...v);
  }
  return meshBounds({ positions, indices: [] });
}

function volume(mesh: MeshData): number {
  const p = mesh.positions;
  let sum = 0;
  for (let i = 0; i < mesh.indices.length; i += 3) {
    const [a, b, c] = [mesh.indices[i]!, mesh.indices[i + 1]!, mesh.indices[i + 2]!];
    const [ax, ay, az] = [p[a * 3]!, p[a * 3 + 1]!, p[a * 3 + 2]!];
    const [bx, by, bz] = [p[b * 3]!, p[b * 3 + 1]!, p[b * 3 + 2]!];
    const [cx, cy, cz] = [p[c * 3]!, p[c * 3 + 1]!, p[c * 3 + 2]!];
    sum += ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx);
  }
  return sum / 6;
}

const cases: Array<[string, Entity]> = [
  ['cylinder along +Z', solid({ kind: 'cylinder', radius: 2, height: 10, position: [1, 2, 3] })],
  [
    'box rotated about all three axes',
    solid({ kind: 'box', size: [10, 4, 2], position: [5, 0, 0], rotation: [0.3, 0.5, 0.7] }),
  ],
  [
    'cone rotated',
    solid({ kind: 'cone', radius: 3, height: 8, position: [0, 0, 0], rotation: [0, 0.4, 0.2] }),
  ],
  ['torus', solid({ kind: 'torus', ringRadius: 6, tubeRadius: 1.5, position: [0, 0, 2] })],
  ['wedge', solid({ kind: 'wedge', size: [4, 3, 6], position: [1, 1, 1], rotation: [0.2, 0, 0] })],
  [
    'pyramid',
    solid({ kind: 'pyramid', baseWidth: 4, baseDepth: 2, height: 5, position: [0, 0, 0] }),
  ],
  [
    'partial revolution about y',
    solid({
      kind: 'revolution',
      profile: [
        [2, 0],
        [4, 0],
        [4, 3],
        [2, 3],
      ],
      axis: [0, 1, 0],
      angle: Math.PI / 2,
      segments: 16,
      position: [0, 0, 0],
    }),
  ],
];

describe('manifold kernel follows llull geometry conventions', () => {
  it.each(cases)('%s: kernel solid has the bounds llull renders', (_label, entity) => {
    const mesh = kernel.tessellate(entity);
    expect(mesh).not.toBeNull();
    const actual = meshBounds(mesh!);
    const expected = llullBounds(entity);
    for (let k = 0; k < 3; k++) {
      expect(actual.min[k]).toBeCloseTo(expected.min[k]!, 1);
      expect(actual.max[k]).toBeCloseTo(expected.max[k]!, 1);
    }
  });

  it('cuts a +Z hole through a plate (cylinder axis is Z, not Y)', () => {
    const plate = solid({ kind: 'box', size: [20, 20, 2], position: [0, 0, 0] });
    const hole = solid({ kind: 'cylinder', radius: 3, height: 10, position: [0, 0, 0] });
    const result = kernel.booleanOp('subtract', plate, hole);
    expect(result).not.toBeNull();
    const expected = 20 * 20 * 2 - Math.PI * 9 * 2;
    expect(volume(result!)).toBeCloseTo(expected, -1);
    // A Y-axis cylinder would cut a full-length channel instead and leave the z extent intact
    // but remove ~2·r·20·2 of material; the volume check above distinguishes the two.
  });

  it('accepts a triangle-soup mesh (welds shared corners) as a boolean operand', () => {
    const box = solid({ kind: 'box', size: [2, 2, 2], position: [0, 0, 0] });
    const positions: number[] = [];
    for (const t of entityToTriangles(box, createEmptyDocument())) {
      for (const v of t) positions.push(...v);
    }
    const soup = solid({
      kind: 'mesh',
      mesh: { positions, indices: positions.map((_, i) => i).slice(0, positions.length / 3) },
      position: [0, 0, 0],
    });
    const other = solid({ kind: 'box', size: [2, 2, 2], position: [1, 0, 0] });
    const union = kernel.booleanOp('union', soup, other);
    expect(union).not.toBeNull();
    expect(volume(union!)).toBeCloseTo(12, 3);
  });
});
