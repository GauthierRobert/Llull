/**
 * @layer server/tests
 * Live OpenCascade vs Manifold: wedge, pyramid and revolution (no exact OCC maker; their
 * triangles are sewn into a solid) are valid boolean operands that agree with Manifold, which
 * works from the same triangles.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import type { Entity, Vec3 } from '@core/model/types';
import type { GeometryKernel, MeshData } from '@core/geometry/kernel';
import { createManifoldKernel } from '@kernel-manifold/manifoldKernel';
import { createNodeOcctKernel } from '../src/occtNode';

const common = { layerId: 'layer-default', color: '#888888' };
const at = (
  position: Vec3,
  rotation: Vec3,
): Pick<Entity, 'position' | 'rotation' | 'layerId' | 'color'> => ({
  position,
  rotation,
  ...common,
});

const shapes: Array<[string, (position: Vec3, rotation: Vec3) => Entity]> = [
  ['wedge', (p, r) => ({ id: 'w', kind: 'wedge', size: [4, 3, 5], ...at(p, r) }) as Entity],
  [
    'pyramid',
    (p, r) =>
      ({ id: 'y', kind: 'pyramid', baseWidth: 4, baseDepth: 3, height: 5, ...at(p, r) }) as Entity,
  ],
  [
    'revolution',
    (p, r) =>
      ({
        id: 'v',
        kind: 'revolution',
        profile: [
          [1, 0],
          [2, 0],
          [2, 3],
          [1, 3],
        ],
        axis: [0, 0, 1],
        angle: Math.PI * 2,
        segments: 24,
        ...at(p, r),
      }) as Entity,
  ],
];

const box = (position: Vec3, size: Vec3): Entity =>
  ({ id: 'b', kind: 'box', rotation: [0, 0, 0], position, size, ...common }) as Entity;

function volume(mesh: MeshData): number {
  const p = mesh.positions;
  let sum = 0;
  for (let i = 0; i < mesh.indices.length; i += 3) {
    const [a, b, c] = [0, 1, 2].map((k) => (mesh.indices[i + k] ?? 0) * 3) as [
      number,
      number,
      number,
    ];
    sum +=
      ((p[a] ?? 0) * ((p[b + 1] ?? 0) * (p[c + 2] ?? 0) - (p[b + 2] ?? 0) * (p[c + 1] ?? 0)) -
        (p[a + 1] ?? 0) * ((p[b] ?? 0) * (p[c + 2] ?? 0) - (p[b + 2] ?? 0) * (p[c] ?? 0)) +
        (p[a + 2] ?? 0) * ((p[b] ?? 0) * (p[c + 1] ?? 0) - (p[b + 1] ?? 0) * (p[c] ?? 0))) /
      6;
  }
  return sum;
}

let occt: GeometryKernel;
let manifold: GeometryKernel;
beforeAll(async () => {
  occt = await createNodeOcctKernel();
  manifold = await createManifoldKernel();
}, 120_000);

describe.each(shapes)('occt %s', (name, make) => {
  it.each([
    ['origin', [0, 0, 0], [0, 0, 0]],
    ['moved and turned', [2, -1, 3], [0.3, -0.4, 0.9]],
  ] as Array<[string, Vec3, Vec3]>)('tessellates with the Manifold volume (%s)', (_l, p, r) => {
    const entity = make(p, r);
    const [fromOcct, fromManifold] = [occt.tessellate(entity), manifold.tessellate(entity)];
    expect(fromOcct, name).not.toBeNull();
    expect(fromManifold, name).not.toBeNull();
    expect(volume(fromOcct!)).toBeGreaterThan(0);
    expect(volume(fromOcct!) / volume(fromManifold!)).toBeCloseTo(1, 2);
  });

  it.each(['union', 'subtract', 'intersect'] as const)(
    '%s with a box agrees with Manifold',
    (op) => {
      const entity = make([0.3, 0.2, 0.1], [0.2, -0.1, 0.4]);
      const other = box([1.3, 0.7, 1.9], [3.1, 2.3, 2.7]);
      const [fromOcct, fromManifold] = [
        occt.booleanOp(op, entity, other),
        manifold.booleanOp(op, entity, other),
      ];
      expect(fromOcct, `${name} ${op}`).not.toBeNull();
      expect(fromManifold, `${name} ${op}`).not.toBeNull();
      expect(volume(fromOcct!) / volume(fromManifold!)).toBeCloseTo(1, 2);
    },
  );
});

// Revolution is built exactly (MakeRevol) in llull's frame for the dominant axis component:
// every axis, a partial sweep and either profile winding must give the Manifold solid.
describe('occt revolution frames', () => {
  const ring: Array<[number, number]> = [
    [1, 0.5],
    [2.5, 0.5],
    [2.5, 3],
    [1, 2],
  ];
  const revolution = (
    profile: Array<[number, number]>,
    axis: Vec3,
    angle: number,
    position: Vec3 = [1, -2, 3],
  ): Entity =>
    ({
      id: 'v',
      kind: 'revolution',
      profile,
      axis,
      angle,
      segments: 48,
      position,
      rotation: [0, 0, 0],
      ...common,
    }) as Entity;

  const spans = (mesh: MeshData): number[] => {
    const lo = [Infinity, Infinity, Infinity];
    const hi = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < mesh.positions.length; i += 3) {
      for (let k = 0; k < 3; k++) {
        lo[k] = Math.min(lo[k] ?? 0, mesh.positions[i + k] ?? 0);
        hi[k] = Math.max(hi[k] ?? 0, mesh.positions[i + k] ?? 0);
      }
    }
    return [...lo, ...hi];
  };

  it.each([
    ['Z axis, full', [0, 0, 1], Math.PI * 2],
    ['Y axis, full', [0, 1, 0], Math.PI * 2],
    ['X axis, full', [1, 0, 0], Math.PI * 2],
    ['Z axis, half sweep', [0, 0, 1], Math.PI],
    ['Y axis, half sweep', [0, 1, 0], Math.PI],
    ['X axis, quarter sweep', [1, 0, 0], Math.PI / 2],
  ] as Array<[string, Vec3, number]>)('%s matches Manifold', (_label, axis, angle) => {
    for (const profile of [ring, [...ring].reverse()]) {
      const entity = revolution(profile, axis, angle);
      const [fromOcct, fromManifold] = [occt.tessellate(entity), manifold.tessellate(entity)];
      expect(fromOcct).not.toBeNull();
      expect(fromManifold).not.toBeNull();
      const ratio = volume(fromOcct!) / volume(fromManifold!);
      expect(ratio).toBeGreaterThan(0.98);
      expect(ratio).toBeLessThan(1.04);
      spans(fromOcct!).forEach((value, index) =>
        expect(Math.abs(value - (spans(fromManifold!)[index] ?? NaN))).toBeLessThan(0.15),
      );
    }
  });

  it('rejects a degenerate profile, a zero sweep and too few segments', () => {
    const flat: Array<[number, number]> = [
      [0, 0],
      [1, 0],
      [2, 0],
    ];
    expect(occt.tessellate(revolution(flat, [0, 0, 1], Math.PI))).toBeNull();
    expect(occt.tessellate(revolution(ring, [0, 0, 1], 0))).toBeNull();
    expect(
      occt.tessellate({ ...revolution(ring, [0, 0, 1], Math.PI), segments: 2 } as Entity),
    ).toBeNull();
  });
});
